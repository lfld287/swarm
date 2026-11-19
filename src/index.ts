/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentSession, defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ScrollViewScrollbar, type SettingItem, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hasAgentBadge, renderAgentName } from "./agent-color.js";
import { AgentManager } from "./agent-manager.js";
import { AGENT_RECORD_ENTRY_TYPE, type AgentRecordEntryData, agentRecordEntryData, findAgentRecordEntry, reopenTarget } from "./agent-record-entry.js";
import { getAgentConversation, getDefaultMaxTurns, getGraceTurns, getRememberAgents, normalizeMaxTurns, resolveEffectiveMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, setRememberAgents, steerAgent } from "./agent-runner.js";
import { formatAgentTypeList, getAgentConfig, getAvailableTypes, getFallbackSubagent, getModelLabelFromConfig, getToolDescriptionMode, NO_FALLBACK, registerAgents, resolveSpawnType, setFallbackSubagent, setToolDescriptionMode } from "./agent-types.js";
import { getCacheRetention, setCacheRetention } from "./cache-retention.js";
import { inChildSessionContext } from "./child-context.js";
import { CompletionOutbox } from "./completion-outbox.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { GroupJoinManager } from "./group-join.js";
import { isolationParam, resolveAgentInvocationConfig } from "./invocation-config.js";
import { describeMention, handleBase, isReservedHandle, parseMention, resolveHandleToType, stripAgentPrefix } from "./mention.js";
import { runMentionClone } from "./mention-clone.js";
import { describeModel, type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope, isScopeModelsEnabled, setScopeModelsEnabled } from "./model-scope.js";
import { createOutputFilePath, ensureOutputFile, getOutputTranscriptDefault, setOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { getPackageAgentsGate, invalidatePackageCache, seedProjectTrust, setPackageAgentsGate, setProjectTrusted } from "./package-resources.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import {
  applyAndEmitLoaded,
  applySettings,
  defaultSettingsScope,
  isNumericSettingKey,
  loadSettings,
  SETTING_DEFAULTS,
  type SettingsAppliers,
  type SettingsScope,
  type SubagentsSettings,
  saveAndEmitChanged,
  saveSettings,
  settingSources,
  settingsFilePath,
  type ToolDescriptionMode,
} from "./settings.js";
import { getStatusNote, partialOutputSuffix } from "./status-note.js";
import { toSubagentInfo } from "./subagent-info.js";
import { type AgentInvocation, type AgentMentionMode, type AgentRecord, type CacheRetentionSetting, type JoinMode, type NotificationDetails, type SubagentType, THINKING_LEVELS, type ViewerMarkdownMode, type WidgetMode } from "./types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import {
  type AgentActivity,
  AgentWidget,
  formatAge,
  formatCost,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  type UICtx,
} from "./ui/agent-widget.js";
import { createAgentsMenu } from "./ui/agents-menu.js";
import { ConversationViewer, getConversationOverlayOptions } from "./ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { createSettingsPage, type SettingsPageDeps } from "./ui/settings-menu.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, PendingUsagePool, toReportedUsage } from "./usage.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "./worktree.js";
import { escapeXml } from "./xml.js";

// ---- Shared helpers ----

type AgentReceipt = Pick<AgentRecord, "status"> & { agentId: string };

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentReceipt) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

function toolError(message: string) {
  return { ...textResult(message), isError: true };
}

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 */
function createActivityTracker(maxTurns?: number) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
  };

  return { state, callbacks };
}

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number, showCost = false): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";
  // Only under `showCost`: this is LLM context, and a figure the orchestrator
  // did not ask for is a figure it may start reporting unprompted.
  const cost = showCost ? getLifetimeCost(record.lifetimeUsage) : 0;
  const costXml = cost > 0 ? `<estimated_cost_usd>${cost.toFixed(4)}</estimated_cost_usd>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}${costXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    // Carried unconditionally; the renderer gates on the setting. Details are
    // data, and a notification rendered before a mid-session toggle should not
    // be stuck with the old answer.
    totalCost: getLifetimeCost(record.lifetimeUsage),
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

export default function (pi: ExtensionAPI) {
  // Child AgentSessions load normal extensions. Re-entering this extension there
  // would create another manager and expose orchestration in child sessions.
  if (inChildSessionContext()) return;

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (showCost) {
          const costText = formatCost(d.totalCost ?? 0);
          if (costText) parts.push(costText);
        }
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: output file link (if present)
        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      const rendered = all.map(renderOne);
      // A group of agents lands as one notification, and the number a user wants
      // from it is what the batch cost — not four figures to add up by hand.
      // Derived from the per-agent details rather than carried alongside them:
      // one source, so the total can never disagree with the rows above it.
      if (showCost && all.length > 1) {
        const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
        if (total) {
          const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
          rendered.unshift(theme.fg("dim", `${all.length} agents · ${formatTokens(tokens)} · ${total}`));
        }
      }
      return new Text(rendered.join("\n"), 0, 0);
    }
  );

  // Read directly rather than waiting for applyAndEmitLoaded below: these decide
  // the initial load, which happens hundreds of lines before settings are applied.
  const bootSettings = loadSettings(process.cwd());
  let strictAgentFiles = bootSettings.strictAgentFiles === true;

  // Seed the package agent gate before the first load so the initial registry
  // honours it. `applyAndEmitLoaded` sets it again through the appliers.
  setPackageAgentsGate(bootSettings.packageAgents);
  // And seed project trust from pi's saved decision, because the initial load is
  // the one the `Agent` tool description is built from — see `seedProjectTrust`.
  seedProjectTrust(process.cwd());

  /** Reload agents from package/global/project agent dirs (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  // Initial load — the only strict one. A bad edit mid-session must not kill the
  // session on the next unrelated spawn, so every later reload keeps warning.
  reloadCustomAgents(strictAgentFiles);

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Usage reporting (both off by default; see SubagentsSettings) ----
  /** Attach subagent spend to tool results, so the parent session counts it. */
  let reportUsage = false;
  function isReportUsageEnabled(): boolean { return reportUsage; }
  function setReportUsage(b: boolean): void {
    reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) pendingUsage.drain();
  }
  /** Show `~$X` next to token counts in the subagent surfaces. */
  let showCost = false;
  function isShowCostEnabled(): boolean { return showCost; }
  function setShowCost(b: boolean): void { showCost = b; widget.update(); fleet.update(); }
  /** Name the model and thinking level on the widget's running rows and the fleet rows. */
  let showModel = false;
  function isShowModelEnabled(): boolean { return showModel; }
  function setShowModel(b: boolean): void { showModel = b; widget.update(); fleet.update(); }
  /**
   * How much of the conversation viewer renders as Markdown. Read through a
   * getter by the viewer rather than captured like `showCost`, because the
   * viewer's `m` key writes back here while the overlay is on screen.
   */
  let viewerMarkdown: ViewerMarkdownMode = "assistant";
  function getViewerMarkdown(): ViewerMarkdownMode { return viewerMarkdown; }
  function setViewerMarkdown(mode: ViewerMarkdownMode): void { viewerMarkdown = mode; }
  /**
   * The viewer's `m` key, from either entry point: set the mode and persist it,
   * so the key and `/agents → Settings` stay one setting rather than one per
   * entry point. `ctx` carries only the warning a failed write notifies with,
   * and the fleet list may be acting without one.
   */
  function chooseViewerMarkdown(mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext): void {
    setViewerMarkdown(mode);
    persistSettings(ctx, `Viewer markdown set to ${mode}`);
  }
  const pendingUsage = new PendingUsagePool();

  // ---- Completion delivery ----
  // Every completion notification goes through the outbox, which sends what is
  // pending as one message at the parent's next boundary (see
  // completion-outbox.ts). Each is built when the agent finishes, and reading
  // the result (get_subagent_result, rpc consume) cancels it before it is sent.
  const outbox = new CompletionOutbox(
    (message) => pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: message.content,
      display: true,
      details: message.details,
    }, { deliverAs: "steer", triggerTurn: true }),
    () => currentCtx?.signal !== undefined,
  );
  function sendIndividualNudge(record: AgentRecord) {
    const activity = agentActivity.get(record.id);
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    // Built now, so a resume before the send cannot rewrite it. A record that
    // cannot be formatted is skipped, as a failed send always was.
    try {
      const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';
      const message = {
        content: formatTaskNotification(record, 500, showCost) + footer,
        details: buildNotificationDetails(record, 500, activity),
      };
      outbox.add({ ids: [record.id], build: () => message });
    } catch { /* ignore stale completion side-effect errors */ }
    widget.update();
  }

  // ---- Group join manager (`group` join mode only) ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      const members = records.filter(r => !r.resultConsumed).flatMap(r => {
        try {
          return [{ id: r.id, text: formatTaskNotification(r, 300, showCost), details: buildNotificationDetails(r, 300, agentActivity.get(r.id)) }];
        } catch { return []; /* as in sendIndividualNudge */ }
      });
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); fleet.onAgentFinished(r.id); }
      if (members.length > 0) {
        outbox.add({
          ids: members.map(m => m.id),
          build: (ids) => {
            const unread = members.filter(m => ids.includes(m.id));
            const notifications = unread.map(m => m.text).join('\n\n');
            const label = partial
              ? `${unread.length} agent(s) finished (partial — others still running)`
              : `${unread.length} agent(s) finished`;

            const [first, ...rest] = unread;
            const details = first.details;
            if (rest.length > 0) details.others = rest.map(m => m.details);
            return {
              content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
              details,
            };
          },
        });
      }
      widget.update();
    },
    30_000,
  );

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    pi.events.emit(isError ? "subagents:failed" : "subagents:completed", toSubagentInfo(record));

    // Persist the final record: get_subagent_result answers from it once the
    // live record is gone, and other extensions reconstruct history from it.
    pi.appendEntry<AgentRecordEntryData>(AGENT_RECORD_ENTRY_TYPE, agentRecordEntryData(record));

    // A consumed result still counts as settled in its group.
    if (record.resultConsumed) {
      groupJoin.onAgentComplete(record);
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      fleet.onAgentFinished(record.id);
      widget.update();
      return;
    }

    // A `group` spawn whose turn has not ended yet: its group is registered at
    // that turn's end, which picks this completion up retroactively.
    if (turnGroupSpawns.includes(record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    widget.update();
  }, undefined, (record) => {
    // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
    // and scheduler spawns enter through the manager directly.
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", toSubagentInfo(record));
  }, (record, info) => {
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      ...toSubagentInfo(record),
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (record, usage) => {
    // Every assistant message from every agent, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it.
    if (reportUsage) pendingUsage.add(usage);
    // The same message, live, for anyone keeping their own ledger — a footer
    // that breaks spend down by agent type and thinking level, say. This is the
    // one place every agent's spend passes through, which is why it is emitted
    // here and not from the lifecycle events: those carry spend once, at the
    // end, so a running agent would read as free until it stopped.
    // Deliberately ungated by `reportUsage` — that decides whether the
    // parent session's own totals include this spend, not whether it happened.
    //
    // `model` and `thinking` are read off the record per message, not captured
    // at spawn: the record is authoritative only once the session exists and pi
    // has clamped the level to the model (see `onSessionCreated`).
    const reported = toReportedUsage(usage);
    if (!reported) return;
    // A key whose value is unknown is omitted, never `undefined`: `model` and
    // `thinking` until the session has reported them.
    const invocation = record.invocation;
    pi.events.emit("subagents:usage", {
      id: record.id,
      type: record.type,
      description: record.description,
      ...(invocation?.modelId !== undefined ? { model: invocation.modelId } : {}),
      ...(invocation?.thinking !== undefined ? { thinking: invocation.thinking } : {}),
      // Set only when the caller did not get the level it asked for (pi
      // clamped it to the model, or an agent file outranked it), so a ledger
      // can show `low (asked minimal)` instead of silently relabelling.
      ...(invocation?.requestedThinking !== undefined ? { requestedThinking: invocation.requestedThinking } : {}),
      usage: reported,
    });
  }, (record, message) => {
    pi.events.emit("subagents:steered", { ...toSubagentInfo(record), message });
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  // Documented for callers in docs/rpc.md ("The manager registry").
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    // A saved-session reopen has just reloaded and strictly resolved its own
    // role via reopenTarget. Do not re-resolve it using dispatch fallback.
    if (options?.resumeSessionFile === undefined) {
      reloadCustomAgents();
      const dispatch = resolveSpawnType(type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      type = dispatch.type;
    }
    // Every programmatic spawn lands here — cross-extension RPC, both `@handle`
    // mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
    // none came through the Agent tool, which is where the UI activity tracker is
    // otherwise created. Without one the widget and FleetView have no tool name
    // and no turn count, so the row reads `thinking…` for the agent's whole life
    // while the header's tool-use count climbs beside it (#181). Double-tracking
    // is not possible: the Agent tool calls `manager.spawn` directly. The tracker
    // callbacks are the funnel's own — a caller's are not honoured, since a
    // half-wired tracker renders worse than none.
    //
    // The turn limit is resolved rather than read off `options`, which a mention
    // spawn deliberately omits so the agent's own config can decide: a tracker
    // built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
    // Like the tool's own, it is a prediction — editing the agent file mid-run
    // leaves the displayed ceiling stale.
    const { state, callbacks } = createActivityTracker(resolveEffectiveMaxTurns(type, options?.maxTurns));
    // Repaints are left to the manager's `onStart` callback, which already starts
    // the widget/fleet timers for agents that enter this way.
    const id = manager.spawn(piRef, ctxRef, type, prompt, { ...options, ...callbacks });
    agentActivity.set(id, state);
    return id;
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    if (safeOptions.description == null && typeof prompt === "string") safeOptions.description = describeMention(prompt);
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    // Queue bypass is reserved for the scheduler, not public callers.
    delete safeOptions.bypassQueue;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read.
   */
  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    if (byId) return byId;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  /**
   * get_subagent_result's answer from a persisted record, once the live record
   * is gone. The record lasts as long as the session file, so it states when
   * the run finished: a days-old result must not read as current (#436).
   */
  const formatSavedAgentRecord = (saved: AgentRecordEntryData): string =>
    `Agent: ${saved.id}\n` +
    `Type: ${getDisplayName(saved.type)} | Status: ${saved.status}${getStatusNote(saved.status)} | Duration: ${formatDuration(saved.startedAt, saved.completedAt)}\n` +
    (saved.completedAt ? `Finished: ${new Date(saved.completedAt).toISOString().slice(0, 16)}Z (${formatAge(saved.completedAt)} ago)\n` : "") +
    `Description: ${saved.description}\n` +
    `(From the session's saved record: the live record has been cleaned up, so its stats and conversation are gone.)\n\n` +
    (saved.status === "error" ? `Error: ${saved.error}${partialOutputSuffix(saved)}` : saved.result?.trim() || "No output.");

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => manager.getRecord(id),
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered orchestration out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;
  /** Whether the `@handle` autocomplete wrapper has been stacked on pi's provider. */
  let mentionProviderRegistered = false;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[orchestration] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    // Pi resolves project trust before the first session starts, so this is the
    // earliest honest answer. The activation-time load defaulted to untrusted,
    // so a trusted project's `packages[]` only becomes visible now.
    setProjectTrusted(ctx.isProjectTrusted?.() === true);
    // Unconditional, and not folded into the call above: `/reload` and a new or
    // resumed session all land here, and any of them may follow a `pi install`
    // that added a package the cached root list predates.
    invalidatePackageCache();
    reloadCustomAgents();
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
    }
    manager.clearCompleted(true);
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          getRecord: (id) => manager.getRecord(id),
          listAgents: () => manager.listAgents(),
          isNotificationPending: (id) => {
            const record = manager.getRecord(id);
            if (!record || record.resultConsumed) return false;
            if (record.status === "running" || record.status === "queued") return false;
            // The three places a settled agent's completion waits: the outbox,
            // a `group` holding it for its siblings, and a `group` spawn whose
            // turn has not ended yet (see the manager's onComplete).
            return outbox.has(id) || groupJoin.isHolding(id) || turnGroupSpawns.includes(id);
          },
          abort: (id) => manager.abort(id),
          waitForSettled: (id, timeoutMs) => manager.waitForSettled(id, timeoutMs),
          isSettling: (id) => manager.isSettling(id),
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            // Same guard as get_subagent_result: a running agent has no result
            // to consume, and its notification is still the caller's only
            // signal that it finished.
            if (!record) return false;
            if (record.completedAt === undefined) return false;
            record.resultConsumed = true;
            outbox.cancel(record.id);
            return true;
          },
          steer: (id, message) => manager.steer(id, message),
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !mentionProviderRegistered) {
      mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider(current =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
          () => mentionRoster(manager, mentionTypes(), getDisplayName),
          isAgentMentionsEnabled,
        ),
      );
    }
  });

  // Start a mentioned agent the direct way. runAgent resolves model, thinking,
  // max turns and `isolated` from the agent's own config when the spawn omits
  // them, but not `inherit_context`: an RPC caller decides that one itself. A
  // mention is the user starting the agent from this session, so the file does —
  // reloaded first, as the spawn reloads it, so a mid-session edit is not missed.
  const startMentioned = (ctx: ExtensionContext, type: string, message: string) => {
    reloadCustomAgents();
    return spawnTopLevel(pi, ctx, type, message, {
      description: describeMention(message),
      inheritContext: getAgentConfig(type)?.inheritContext,
    });
  };

  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage,
    // scheduled prompts) — only something a person typed can be a mention.
    if (event.source === "extension" || !isAgentMentionsEnabled()) return { action: "continue" };
    // Claiming the turn is TUI only, matching the `@` completion that teaches
    // the syntax. Pi defaults `session.prompt()` to source "interactive", so a
    // headless `pi -p "@explore …"` reaches here too — and claiming it would
    // answer with silence, which the background hold cannot fix: `handled`
    // returns from prompt() before any turn starts, so the loop that patch wraps
    // never runs (it holds subagents spawned by the Agent tool MID-turn, a
    // different path). The agent would detach, `ctx.ui.notify` is a no-op
    // outside the TUI, and print mode would exit having printed nothing.
    //
    // `model` mode has none of that problem: it queues a reminder and lets the
    // turn run, so the answer is the model's own, printed as usual. It is the
    // only branch allowed to act headlessly; everything else falls through to
    // the main model exactly as it did before mentions existed.
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && getAgentMentionMode() !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return { action: "transform", text: mention.message, ...(event.images && { images: event.images }) };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved = manager.resolveMention(mention.handle)
      ?? (alias ? manager.resolveMention(alias) : undefined);

    // Steering and resuming are direct in every mode, so headless they are not
    // available at all. Falling through here rather than dropping to the start
    // path below matters: the handle names an agent that already exists, and
    // asking the model to start another one is not what was typed.
    if (resolved && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        manager.steer(record.id, mention.message);
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        // Both derived from the record's OWN type: a mention names an existing
        // agent, so its frontmatter is what governs — `output_transcript: false`
        // must keep holding, since record.outputFile is the sole gate every
        // downstream consumer keys off and a resume must not re-open it.
        const resumedRecord = startBackgroundResume(ctx, record, mention.message, {
          outputTranscript: getAgentConfig(record.type)?.outputTranscript ?? getOutputTranscriptDefault(),
          maxTurns: resumeTurnLimit(record),
        });
        ctx.ui.notify(
          resumedRecord ? `Resuming ${target}` : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below, like Claude's
      // `no_transcript`.
    }

    // Evicted, but its conversation is still on disk: reopen it. This is an
    // ordinary spawn carrying a session file, so the new record picks up the
    // widget, fleet row, transcript and completion notification unchanged —
    // and `reclaim` hands it back the names the tombstone was holding.
    const retry = resolved?.kind === "live" ? manager.failedReopen(resolved.record.id) : undefined;
    const entry = retry ? agentRecordEntryData(retry) : resolved?.kind === "tombstone" ? resolved.entry : undefined;
    if (entry) {
      const target = `@${entry.alias ?? entry.handle ?? mention.handle}`;

      reloadCustomAgents();
      const reopen = reopenTarget(entry.type, entry.sessionFile, entry.worktreeLost);
      if (!reopen.ok) {
        // A session that is gone can only ever fail, so its row goes with it;
        // an unavailable agent stays, since re-enabling it makes the handle
        // work again.
        if (reopen.gone && entry.handle) manager.dropTombstone(entry.handle);
        ctx.ui.notify(`Could not resume ${target} — ${reopen.reason}.`, "warning");
        return { action: "handled" };
      }

      try {
        // spawnResolved, not spawnTopLevel: the latter strips
        // `resumeSessionFile` and `reclaim` as untrusted. This path is the
        // exception — both come from a tombstone this extension wrote.
        spawnResolved(pi, ctx, reopen.type, mention.message, {
          description: entry.description,
          reclaim: { id: retry?.id, handle: entry.handle, alias: entry.alias },
          resumeSessionFile: reopen.sessionFile,
        });
        // The tombstone deliberately stays. `resolveMention` prefers the live
        // record holding these same names, so it cannot shadow the resume — and
        // if this run dies before establishing its own session, the original
        // transcript is still the right thing for the next mention to reopen.
        // Once the resumed record is evicted it overwrites this entry in place,
        // keyed by the same handle, so nothing accumulates.
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        // The type is already settled above, so what is left is a spawn-time
        // failure such as an unusable cwd.
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    const typeHandle = mention.handle;
    const type = resolveHandleToType(typeHandle, getAvailableTypes())
      ?? (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    // Claude Code never starts the agent itself: `@agent-<type>` becomes an
    // attachment asking the main model to do it, and the model writes the
    // agent's prompt from the conversation rather than forwarding the typed
    // text. That buys a real `Agent` tool call — transcript, per-tool widget
    // detail, tool-use-id correlation, join grouping — and a prompt with the
    // context a cold spawn lacks.
    //
    // It also costs a visible turn, spent narrating a decision the user already
    // made by typing the handle. So the turn is taken by a clone of this
    // conversation instead (mention-clone.ts): same messages, same system
    // prompt, off-screen, holding only the `Agent` tool. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    if (getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      // "Prompting", not "Starting": in this mode nothing starts until the
      // off-screen clone has taken a whole model turn writing the agent's
      // prompt, and that wait is the one thing the chat cannot show. `direct`
      // says "Started" because by then it has. The distinction tells the user
      // which of the two they are waiting on.
      ctx.ui.notify(`Prompting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn, and prompt() is blocked
      // until this hook returns. The user gets their prompt back immediately
      // and the agent appears in the widget when it starts.
      void runMentionClone({ ctx, type, message: mention.message, agentTool: registeredAgentTool })
        .then((result) => {
          if (result.spawned) return;
          // A clone that could not run must not swallow the mention: start the
          // agent the direct way rather than leaving the user with a toast and
          // nothing running.
          try {
            startMentioned(ctx, type, mention.message);
            ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
          } catch (err) {
            ctx.ui.notify(
              `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        });
      return { action: "handled" };
    }

    try {
      // The manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract the scheduler and
      // cross-extension RPC spawns run under.
      startMentioned(ctx, type, mention.message);
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(`Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return { action: "handled" };
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    scheduler.stop();
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle?.unsubSteer();
    rpcHandle?.unsubGet();
    rpcHandle?.unsubList();
    rpcHandle = undefined;
    currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    scheduler.stop();
    manager.abortAll();
    // Activation-owned UI and group state (#256): `session_shutdown` also runs for
    // reload and session replacement, where the Node process survives, so a live
    // widget render interval or a pending group-join timeout from this activation
    // would outlive it and fire into the next session's UI and group state.
    // `session_before_switch` deliberately keeps both: a vetoed switch continues
    // this session, where the live UI and group state must survive.
    groupJoin.dispose();
    widget.dispose();
    outbox.dispose();
    fleet.dispose();
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await manager.dispose(pi);
    // Every agent is stopped and every child session has shut down, so no more
    // `subagents:usage` can arrive. A ledger flushing in its own
    // `session_shutdown` may have run before this handler aborted the agents
    // (handlers run in load order) and missed their last messages; this is the
    // point after which a synchronous final flush is complete. Synchronous:
    // `emit` does not await listeners, and pi exits once this handler returns.
    pi.events.emit("subagents:disposed", {});
  });

  // Live widget: show running agents above editor.
  let widgetMode: WidgetMode = "all";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  const widget = new AgentWidget(manager, agentActivity, getWidgetMode, isShowCostEnabled, isShowModelEnabled);
  function setWidgetMode(m: WidgetMode): void { widgetMode = m; widget.update(); }

  /**
   * pi's fullscreen scrollbar preference, read from the main session's live,
   * trust-aware settings and normalized as pi's own `getFullscreenScrollbar()` does.
   */
  function getFullscreenScrollbar(): ScrollViewScrollbar {
    const mode = pi.getSettings().fullscreenScrollbar;
    return mode === "always" || mode === "hidden" ? mode : "auto";
  }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  // The trailing arguments keep a conversation overlay opened here identical to
  // one opened from `/agents`: same settings on the way in, same persist out.
  const fleet = new FleetList(manager, agentActivity, isShowCostEnabled, getViewerMarkdown,
    (mode) => chooseViewerMarkdown(mode, currentCtx as unknown as ExtensionCommandContext | undefined),
    getFullscreenScrollbar, isShowModelEnabled);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  // Claude Code-style `@handle message` prompt mentions. Read live by both the
  // `input` hook and the stacked autocomplete provider, so the toggle applies
  // immediately — the provider itself can never be unregistered (pi's wrapper
  // list is append-only), it just delegates everything when this is off.
  let agentMentionMode: AgentMentionMode = "model";
  function getAgentMentionMode(): AgentMentionMode { return agentMentionMode; }
  function setAgentMentionMode(mode: AgentMentionMode): void { agentMentionMode = mode; }
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  function isAgentMentionsEnabled(): boolean { return agentMentionMode !== "off"; }

  // The Agent tool reads the project/global .output transcript default from
  // output-file.ts when spawning a background agent. A custom agent's
  // `output_transcript` frontmatter overrides it per spawn.

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean { return schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { schedulingEnabled = b; }

  // ---- Turn batches for `group` join mode ----
  // Background spawns the parent made in its current turn. The turn's end is
  // the batch boundary: every `Agent` call of the batch has returned by then,
  // so a slow worktree copy cannot split the batch.
  let turnGroupSpawns: string[] = [];
  let turnGroupCounter = 0;

  /** Record a `group`-mode spawn made inside a parent turn. */
  function joinTurnGroup(id: string, joinMode: JoinMode | undefined) {
    // Outside a parent turn (an `@handle` mention) no turn end is coming, and a
    // group of one is delivered exactly like a single completion.
    if (joinMode === 'group' && currentCtx?.signal !== undefined) turnGroupSpawns.push(id);
  }

  /** Register the ending turn's `group` spawns, two or more, as one group. */
  function registerTurnGroup() {
    const ids = turnGroupSpawns;
    turnGroupSpawns = [];
    // One spawn is no group: it reports like any single completion.
    if (ids.length < 2) {
      const record = ids.length === 1 ? manager.getRecord(ids[0]) : undefined;
      if (record?.completedAt != null && !record.resultConsumed) sendIndividualNudge(record);
      return;
    }
    const groupId = `turn-${++turnGroupCounter}`;
    groupJoin.registerGroup(groupId, ids);
    // Members that finished before their turn ended had their completion
    // deferred (see the manager's onComplete); feed them in now.
    for (const id of ids) {
      const record = manager.getRecord(id);
      if (!record) continue;
      record.groupId = groupId;
      if (record.completedAt != null) {
        groupJoin.onAgentComplete(record);
      }
    }
  }

  /**
   * The turn budget for resuming `record`, from its OWN type — resume ignores
   * `subagent_type`. Same precedence as a spawn, frontmatter authoritative:
   * the agent file's `max_turns`, else the call's, else the limit the agent
   * was spawned with, else the default (#368).
   */
  function resumeTurnLimit(record: AgentRecord, explicit?: number): number | undefined {
    return normalizeMaxTurns(getAgentConfig(record.type)?.maxTurns ?? explicit ?? record.invocation?.maxTurns ?? getDefaultMaxTurns());
  }

  /**
   * Launch a detached resume of an existing agent and wire everything a
   * re-running agent needs: transcript anchoring, activity tracking, join-mode
   * batching, the widget/fleet refresh, and the `subagents:created` event.
   *
   * Shared by the Agent tool's `resume` branch and the
   * `@handle message` prompt mention — they differ only in how they report the
   * outcome. Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume).
   *
   * Callers must have already established that the record has a session.
   */
  function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): AgentRecord | undefined {
    const id = existing.id;
    if (existing.status === "running" || existing.status === "queued" || manager.isSettling(id)) return undefined;
    const joinMode = defaultJoinMode;
    // Assigned unconditionally: the completion notification carries this as
    // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
    // id left by the spawn that created the record. Keeping it would point the
    // orchestrator's new result at a tool call that was answered runs ago.
    existing.toolCallId = opts.toolCallId;
    existing.joinMode = joinMode;
    // Reuse the agent's transcript rather than starting a fresh one: the
    // path is deterministic per agent+session, so writing an initial entry
    // would truncate the previous run's turns (see ensureOutputFile).
    if (opts.outputTranscript) {
      try {
        existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
        ensureOutputFile(existing.outputFile);
      } catch { /* transcripts are optional */ }
    } else {
      existing.outputFile = undefined;
    }
    // Anchor streaming past the turns already on disk, captured BEFORE the
    // run starts. The resumed prompt lands as an ordinary user message at
    // this index, so it is written exactly once.
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
    // resumeAgent has no onSessionCreated — the session predates this run —
    // so seed it directly, or the widget shows no context % for the agent.
    bgState.session = existing.session;

    // Detached runs do not inherit the parent's turn abort signal.
    const record = manager.resume(id, prompt, undefined, {
      maxTurns: opts.maxTurns,
      onTurnEnd: bgCallbacks.onTurnEnd,
      onToolActivity: bgCallbacks.onToolActivity,
      // Fires when the run actually starts — immediately, or on queue
      // drain. Wiring it here (rather than after resume() returns) means a
      // resume stopped while still queued never started streaming, so
      // there is no subscription left behind for a later run to trip over.
      onStarted: () => {
        const rec = manager.getRecord(id);
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      },
    });
    if (!record) return undefined;

    // Only a resume from an Agent call belongs to that call's turn.
    if (opts.toolCallId !== undefined) joinTurnGroup(id, joinMode);

    agentActivity.set(id, bgState);
    // This agent already finished once, so the widget holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    widget.markRunning(id);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    // Resume ignores subagent_type (the record keeps the type it was
    // spawned with), so report the record's own identity — a "created"
    // event carrying the caller's type would re-register the agent under
    // the wrong one in cross-extension mirrors keyed by id.
    pi.events.emit("subagents:created", toSubagentInfo(existing));

    return record;
  }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

  // The parent's tool batch is done and its next model call not yet made: the
  // boundary where completions are delivered, as in Claude Code.
  pi.on("turn_end", (event) => {
    registerTurnGroup();
    outbox.onTurnEnd(event.message.role === "assistant" ? event.message.stopReason : undefined);
  });
  pi.on("agent_end", () => outbox.onAgentEnd());
  pi.on("agent_settled", () => outbox.onAgentEnd());

  const buildTypeListText = () => formatAgentTypeList(getAvailableTypes(), getAgentConfig, false) || "(none)";
  const buildCompactTypeListText = () => formatAgentTypeList(getAvailableTypes(), getAgentConfig, true) || "(none)";

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  // Also how Del on the Settings page applies the value a row falls back to.
  const settingsAppliers: SettingsAppliers = {
    setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
    setDefaultMaxTurns,
    setGraceTurns,
    setDefaultJoinMode,
    setSchedulingEnabled,
    setScopeModels: setScopeModelsEnabled,
    setStrictAgentFiles: (b) => { strictAgentFiles = b; },
    setToolDescriptionMode: setToolDescriptionMode,
    setFleetView: setFleetViewEnabled,
    setAgentMentions: setAgentMentionMode,
    setRememberAgents,
    setCacheRetention,
    setWidgetMode: setWidgetMode,
    setOutputTranscript: setOutputTranscriptDefault,
    setWorktreeIsolation: setWorktreeIsolationEnabled,
    setFallbackSubagent: setFallbackSubagent,
    setReportUsage,
    setShowCost,
    setShowModel,
    setViewerMarkdown,
    setPackageAgents: setPackageAgentsGate,
  };
  applyAndEmitLoaded(settingsAppliers, (event, payload) => pi.events.emit(event, payload));

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Incompatible with inherit_context and resume. Returns a job ID, not an agent ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Same trade as scheduleParam/scheduleGuideline above: `isolationParam` drops
  // the field from the schema when the project set `worktreeIsolation: false`,
  // so the prose has to go with it. Left in, it would teach the model to pass a
  // parameter that isn't declared — accepted (TypeBox sets no
  // `additionalProperties: false`) and then silently dropped by the resolver.
  // With no per-result note by design, the model would have every reason to go
  // on reporting a `pi-agent-*` branch that was never created.
  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  const isolationCompactGuideline = isWorktreeIsolationEnabled()
    ? `\n- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls — they run concurrently.
- Subagents run in the background and return an ID, not a result. You'll be notified when one completes. Never fabricate or predict a pending agent's results.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md or .agents/agents/<name>.md (project), ${getAgentDir()}/agents/<name>.md (global), or provided by installed packages. Project roles override global roles, which override package roles.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Agents run in the background and return an ID immediately. You will be notified on completion — do NOT sleep, poll, or proactively check on progress. Continue with other work or respond to the user instead.
- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}${scheduleGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[orchestration] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[orchestration] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[orchestration] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[orchestration] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  // Held rather than registered inline: the mention clone reuses this exact
  // definition, so the agent it starts is an ordinary top-level spawn instead
  // of a second implementation that has to be kept in step with this one.
  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type. Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ") || "(none)"}.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context. Returns the same agent ID immediately. The resumed run gets a fresh max_turns budget. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme, context) {
      // A badge closes its own background, which would clear the tool block's row tint
      // for the rest of the line, so the badge restores it. The tint is opened here too:
      // the TUI's Box paints it, but HTML export takes it from CSS, and restoring a
      // background the line never opened is what banded the export before. The line is
      // deliberately left open — Box.applyBackgroundToLine pads to width and *then*
      // wraps, so closing here would leave that padding untinted, and HTML export closes
      // any open span per line anyway. No badge means no tint, so an uncolored agent
      // renders exactly the line it always did.
      const rowBackground = hasAgentBadge(args.subagent_type)
        ? theme.getBgAnsi(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg")
        : "";
      const desc = args.description ?? "";
      const name = renderAgentName(args.subagent_type, theme, {
        fallbackColor: "toolTitle",
        restoreBackground: rowBackground,
        bold: true,
      });
      return new Text(rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, _options, theme, renderContext) {
      const details = result.details as AgentReceipt | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (renderContext.isError || !details?.agentId) return new Text(text, 0, 0);
      const status = details.status === "queued" ? "Queued" : "Running";
      return new Text(theme.fg("dim", `  ⎿  ${status} in background (ID: ${details.agentId})`), 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, callParams, _signal, _onUpdate, ctx) => {
      if (Object.hasOwn(callParams, "run_in_background")) {
        return toolError("Agent only runs in the background; omit run_in_background.");
      }
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      // A resume whose record is gone — evicted ten minutes after it finished,
      // or lost to a reload or restart — reopens the agent from the session's
      // saved record of it, under the same id, as Claude Code resumes from the
      // transcript on disk. This is an ordinary spawn carrying a session file,
      // like the `@handle` path's, so it runs through the spawn path below
      // and picks up the widget, fleet row, transcript, join batching and
      // completion notification unchanged. Only the prompt and turn budget
      // carry over from the call: like a live resume, it
      // ignores `subagent_type`, model, thinking and the rest. It runs under the
      // agent type's current prompt and tools, on the model and thinking level
      // its own session recorded (#462) — see the model resolution below.
      // `schedule` is left to its own branch, which refuses the combination.
      const retry = callParams.resume && !callParams.schedule ? manager.failedReopen(callParams.resume) : undefined;
      const saved = retry ? agentRecordEntryData(retry)
        : callParams.resume && !callParams.schedule && !manager.getRecord(callParams.resume)
          ? findAgentRecordEntry(ctx, callParams.resume)
          : undefined;
      let reopenOptions: { resumeSessionFile: string; reclaim: { id: string; handle?: string; alias?: string } } | undefined;
      if (saved !== undefined) {
        const reopen = reopenTarget(saved.type, saved.sessionFile, saved.worktreeLost);
        if (!reopen.ok) return toolError(`Agent "${saved.id}" cannot be resumed — ${reopen.reason}.`);
        reopenOptions = {
          resumeSessionFile: reopen.sessionFile,
          reclaim: { id: saved.id, handle: saved.handle, alias: saved.alias },
        };
      }
      const params: typeof callParams = saved === undefined ? callParams : {
        prompt: callParams.prompt,
        description: saved.description,
        subagent_type: saved.type,
        max_turns: callParams.max_turns,
        isolation: undefined,
        schedule: undefined,
      };

      const rawType = params.subagent_type as SubagentType;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background or scheduled call can't start running the wrong agent while
      // the caller is still unaware. `fallbackSubagent` decides whether an
      // unresolvable type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      // `resume` replays a stored session and ignores `subagent_type` entirely,
      // but the parameter is required by the schema — so gating it here would
      // make a live agent unresumable the moment its type is deleted, disabled,
      // or gains a case-clashing sibling. Only a real spawn is gated.
      if (!dispatch.ok && !params.resume) return { ...textResult(dispatch.message), isError: true };
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // What the caller actually asked for, named once: `fellBackFrom` is "" for
      // a blank request, so reading it inline invites the `??`-vs-`||` slip that
      // once persisted an empty type into a scheduled job.
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      // Disclose type substitution on fresh spawns and schedules, not resumes.
      const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
        ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${subagentType}.\n\n`
        : "";

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
      });

      // Resolve model from agent config first; tool-call params only fill gaps.
      // A reopen resolves none: runAgent leaves the model and thinking level to
      // the reopened session, which restores the ones the agent ran with. The
      // agent file and the parent would both override them (#462).
      let model = reopenOptions ? undefined : ctx.model;
      if (resolvedConfig.modelInput && !reopenOptions) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return toolError(resolved);
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
      // in model-scope.ts and is shared with RPC dispatch.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return toolError(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = reopenOptions ? undefined : resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        try {
          const path = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
          // A reopened agent appends to its previous transcript, never truncates it.
          if (reopenOptions) ensureOutputFile(path);
          else writeInitialEntry(path, agentId, params.prompt, ctx.cwd);
          rec.outputFile = path;
        } catch { /* optional transcript must not invalidate an accepted ID */ }
      };
      // Where a reopened agent's transcript stream starts: past the turns the
      // reopened session already holds, so its new prompt is written once and
      // the old turns are not written again. A spawn starts from its prompt.
      const transcriptAnchor = (session: AgentSession): number | undefined =>
        reopenOptions ? session.messages.length : undefined;

      // Unconditional, not "only when it differs from the parent": a thinking
      // level reads as a property of a model, and an agent that inherited the
      // parent's model used to show the level with nothing to attach it to.
      // This is the pre-session snapshot — agent-manager overwrites it with the
      // effective values the moment a session reports them.
      const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
      // What the caller SPELLED, kept only if it names a different model than the
      // one that won. Model input is fuzzy — `"haiku"` and
      // `"anthropic/claude-haiku-4-5"` are the same model — so comparing the two
      // strings would disclose an override that never happened. A spelling that
      // resolves to nothing is still worth disclosing: it cannot have taken effect.
      const askedModel = ((asked: string | undefined) => {
        if (!asked) return undefined;
        const resolvedAsked = resolveModel(asked, ctx.modelRegistry);
        if (typeof resolvedAsked === "string") return asked;
        return resolvedAsked.provider === model?.provider && resolvedAsked.id === model?.id ? undefined : asked;
      })(resolvedConfig.overridden?.model);
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        modelId,
        thinking,
        // Only set where the agent file outranked the caller, so the surfaces can
        // disclose a parameter that was accepted but could not take effect (#182).
        requestedThinking: resolvedConfig.overridden?.thinking,
        requestedModel: askedModel,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        // Neither is applied to a reopened conversation (runAgent, the
        // manager), so neither is shown.
        inheritContext: reopenOptions ? undefined : inheritContext,
        isolation: reopenOptions ? undefined : isolation,
      };
      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return toolError("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return toolError("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return toolError("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (!scheduler.isActive()) {
          return toolError("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return toolError(err instanceof Error ? err.message : String(err));
        }
      }

      const receipt = (record: AgentRecord, action: string, note = "") => textResult(
        `${note}Agent ${record.status === "queued" ? "queued" : action} in background.\n` +
        `Agent ID: ${record.id}\n` +
        `Type: ${getDisplayName(record.type)} | Status: ${record.status}\n` +
        `Description: ${record.description}\n` +
        (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        (record.status === "queued" ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
        `\nYou will be notified when this agent completes.\n` +
        `Use get_subagent_result after notification, or steer_subagent to send it messages.\n` +
        `Do not duplicate this agent's work.`,
        { status: record.status, agentId: record.id },
      );

      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) return toolError(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        if (existing.status === "running" || existing.status === "queued" || manager.isSettling(existing.id)) {
          return toolError(
            `Agent "${params.resume}" is still ${existing.status === "stopped" ? "settling" : existing.status} — it can only be resumed once its current run finishes.\n` +
            `Use steer_subagent to send a message mid-run, or read its result after notification.`,
          );
        }
        if (!existing.session) return toolError(`Agent "${params.resume}" has no active session to resume.`);
        const record = startBackgroundResume(ctx, existing, params.prompt, {
          outputTranscript: getAgentConfig(existing.type)?.outputTranscript ?? getOutputTranscriptDefault(),
          maxTurns: resumeTurnLimit(existing, params.max_turns),
          toolCallId,
        });
        if (!record) return toolError(`Failed to resume agent "${params.resume}".`);
        return receipt(record, "resumed");
      }

      const { state, callbacks } = createActivityTracker(effectiveMaxTurns);
      const onSessionCreated = callbacks.onSessionCreated;
      let id: string;
      try {
        id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...reopenOptions,
          ...callbacks,
          onSessionCreated: (session) => {
            onSessionCreated(session);
            const rec = manager.getRecord(id);
            if (rec?.outputFile) {
              rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd, transcriptAnchor(session));
            }
          },
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }

      const record = manager.getRecord(id)!;
      record.joinMode = defaultJoinMode;
      record.toolCallId = toolCallId;
      attachTranscript(record, id);
      if (toolCallId !== undefined) joinTurnGroup(id, defaultJoinMode);
      agentActivity.set(id, state);
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();

      pi.events.emit("subagents:created", toSubagentInfo(record));
      return receipt(record, reopenOptions ? "resumed from its saved session" : "started", fallbackNote);
    },
  });
  /**
   * Wrap a tool so its results carry back whatever subagent spend the parent
   * session has not been told about yet (see `PendingUsagePool`).
   *
   * Pi copies `AgentToolResult.usage` onto the persisted tool-result message and
   * folds it into `getSessionStats()`, which is what the footer, the statusline
   * and `/cost` read — so this is the whole of "report usage to the parent".
   *
   * Nothing is attached to a call with no tool-call id. That is the `@handle`
   * mention path (`mention-clone.ts`), which invokes this tool from a fork of the
   * conversation that is discarded moments later: the result never becomes a
   * message in the real session, so usage hung on it would be spend the user paid
   * for and nobody counted. Skipping leaves it pending for the next real result.
   */
  function withUsageReporting<T extends { execute: (...args: any[]) => any }>(tool: T): T {
    return {
      ...tool,
      execute: async (toolCallId: string | undefined, ...rest: any[]) => {
        const result = await tool.execute(toolCallId, ...rest);
        if (!reportUsage || !toolCallId) return result;
        const usage = pendingUsage.drain();
        return usage ? { ...result, usage } : result;
      },
    };
  }
  function registerToolReportingUsage(tool: any): void {
    pi.registerTool(withUsageReporting(tool));
  }

  // The mention path is handed THIS object, not the bare `agentTool` — see the
  // mention-clone header on why the clone must call the registered tool.
  const registeredAgentTool = withUsageReporting(agentTool);
  pi.registerTool(registeredAgentTool);

  // ---- get_subagent_result tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type.",
      }),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (Object.hasOwn(params, "wait")) {
        return toolError("Result reads never wait; omit wait and read after notification.");
      }
      const record = resolveAgentRef(params.agent_id);
      if (!record) {
        // Evicted, or lost to a reload: answer from the record the session saved.
        // An evicted handle still resolves to its id through its tombstone. After
        // a reload there is no tombstone, so the saved entry's handle and alias
        // have to match on their own.
        const tombstone = manager.resolveMention(params.agent_id);
        const savedId = tombstone?.kind === "tombstone" ? tombstone.entry.id : params.agent_id;
        const saved = findAgentRecordEntry(ctx, savedId, tombstone === undefined);
        if (saved) {
          outbox.cancel(saved.id);
          return textResult(formatSavedAgentRecord(saved));
        }
      }
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running" || record.status === "queued") {
        output += `Agent is still ${record.status}. Read the result after notification.`;
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.completedAt !== undefined) {
        record.resultConsumed = true;
        outbox.cancel(record.id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running). The agent's handle also works — its `name` if you gave it one, otherwise its type.",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        if (showCost) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) stateParts.push(costText);
        }
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- /agents interactive menu ----

  // Directory resolution and the frontmatter edits live in agent-file-toggle.ts
  // so they are reachable from tests — this command handler is only registered
  // through `registerCommand`, which every test mocks.

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolved = resolveModel(cfg.model, registry);
    // Configured but unresolvable: the runtime silently falls back to the parent
    // model, so flag it (and the fallback) rather than hiding the config.
    if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
    // Surface what it actually resolved to when that differs from the config —
    // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
    // differences are normalized away so an effectively-identical match stays quiet.
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const session = record.session;
    const activity = agentActivity.get(record.id);
    let overlayOptions = getConversationOverlayOptions({ mode: "regular" });

    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        overlayOptions = getConversationOverlayOptions(tui);
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${record.description}".`, "info");
          }
        }, keybindings, (message: string) => manager.steer(record.id, message), showCost, getViewerMarkdown, (mode) => chooseViewerMarkdown(mode, ctx), getFullscreenScrollbar());
      },
      {
        overlay: true,
        overlayOptions: () => overlayOptions,
      },
    );
  }


  /**
   * Every settings mutation writes this WHOLE object back to disk, so a field
   * missing here is erased from the user's subagents.json the next time they
   * toggle something unrelated. `SubagentsSettings` has every field optional,
   * so a `: SubagentsSettings` return annotation would let a newly-added setting
   * be forgotten here and still type-check. `satisfies` instead: it still checks
   * each value's type and rejects a mistyped key, but leaves the return type
   * inferred so `_NoMissingSettingsKeys` below can check completeness.
   */
  function snapshotSettings() {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited, and the default — see SubagentsSettings.
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      schedulingEnabled: isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      strictAgentFiles,
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      agentMentions: getAgentMentionMode(),
      rememberAgents: getRememberAgents(),
      cacheRetention: getCacheRetention(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      fallbackSubagent: getFallbackSubagent(),
      reportUsage: isReportUsageEnabled(),
      showCost: isShowCostEnabled(),
      showModel: isShowModelEnabled(),
      viewerMarkdown: getViewerMarkdown(),
      packageAgents: getPackageAgentsGate(),
    } satisfies SubagentsSettings;
  }

  // Compile-time completeness guard for snapshotSettings(). If a field is added
  // to SubagentsSettings and not mirrored above, this Exclude is non-empty and
  // fails to satisfy `never` — turning a silent settings-erasure bug into a
  // typecheck error. `npm run typecheck` runs in CI.
  type _NoMissingSettingsKeys =
    Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
      ? true
      : ["snapshotSettings() is missing a SubagentsSettings key"];
  const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
  void _settingsSnapshotIsComplete;

  // The settings as last persisted (or as loaded at startup). A save writes
  // only the keys that differ from it, so a change here cannot revert what
  // another pi session saved to the shared global file, and untouched
  // defaults are never frozen into a file.
  let savedSnapshot: SubagentsSettings = snapshotSettings();

  /** Where a Settings-page change goes: the chosen file, and the setting it set. */
  type SettingsTarget = { scope: SettingsScope; key?: keyof SubagentsSettings };

  /** Persist + broadcast what changed since the last save; the toast to show. */
  function saveSnapshot(successMsg: string, target?: SettingsTarget): { message: string; level: "info" | "warning" } {
    const snapshot = snapshotSettings();
    const { persisted, ...toast } = saveAndEmitChanged(
      snapshot,
      savedSnapshot,
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
      process.cwd(),
      target?.scope,
      target?.key ? { [target.key]: snapshot[target.key] } : {},
    );
    // A failed write keeps the old baseline, so the next save retries this change.
    if (persisted) savedSnapshot = snapshot;
    return toast;
  }

  /**
   * Whether a package gate lets anything through. `undefined` is the unset
   * default and reads as `true`; an empty allowlist matches nothing, like
   * `false`.
   */
  function gateAdmitsAnything(gate: ReturnType<typeof getPackageAgentsGate>): boolean {
    if (gate === undefined || gate === true) return true;
    if (gate === false) return false;
    return gate.length > 0;
  }

  /**
   * Settings-row description for a package gate, naming the configured allowlist
   * when there is one. The row itself is on/off — an allowlist is hand-written in
   * `subagents.json` — so the description is the only place it is visible, and a
   * user about to toggle the row can see what they are about to replace.
   */
  function describeGateSetting(gate: ReturnType<typeof getPackageAgentsGate>, base: string): string {
    if (!Array.isArray(gate)) return base;
    return gate.length > 0
      ? `${base} Currently limited to: ${gate.join(", ")}.`
      : `${base} Currently limited to an empty list, so nothing loads.`;
  }

  // The setting a row shows: its id, except Join mode's.
  const settingKeyOf = (id: string) => (id === "joinMode" ? "defaultJoinMode" : id) as keyof SubagentsSettings;

  /**
   * Put one setting back to `value`, the value loading gives once Del has
   * removed it from a file; `undefined` unsets it. Carries the side effects
   * the Settings rows carry when they change the same setting.
   */
  function resetSetting(key: keyof SubagentsSettings, value: unknown) {
    if (value !== undefined) applySettings({ [key]: value } as SubagentsSettings, settingsAppliers);
    else if (key === "fallbackSubagent") setFallbackSubagent(undefined);
    else if (key === "packageAgents") setPackageAgentsGate(undefined);
    if (key === "packageAgents") reloadCustomAgents();
    if (key === "schedulingEnabled" && !isSchedulingEnabled()) scheduler.stop();
  }

  /**
   * `scope` is the file changes are written to. It starts at the default rule
   * and Tab switches it; the list always shows the effective (merged) values.
   */
  async function showSettings(ctx: ExtensionCommandContext) {
    let scope: SettingsScope = defaultSettingsScope(process.cwd());
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();
      const fallbackValue = getFallbackSubagent() ?? NO_FALLBACK;
      const fallbackValues = [...new Set([...getAvailableTypes(), NO_FALLBACK])];

      // Ordered by category, with no header rows (every row stays a setting the
      // filter can match): limits, dispatch, features, agent files, display.
      return [
        {
          id: "maxConcurrent",
          label: "Max background concurrency",
          description: "Max concurrent background agents; extras wait in a queue (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "smart = each completion at the parent's next boundary, as in Claude Code; group = one notification per turn's batch",
          // `async` is an older name for `smart`; settings files may still hold it.
          currentValue: getDefaultJoinMode() === "group" ? "group" : "smart",
          values: ["smart", "group"],
        },
        {
          id: "fallbackSubagent",
          label: "Fallback agent",
          description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
          currentValue: fallbackValue,
          values: fallbackValues,
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
        {
          id: "schedulingEnabled",
          label: "Scheduling",
          description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
          currentValue: isSchedulingEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "worktreeIsolation",
          label: "Worktree isolation",
          description:
            "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
          currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "agentMentions",
          label: "Agent mentions",
          description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
          currentValue: getAgentMentionMode(),
          values: ["model", "direct", "off"],
        },
        {
          id: "rememberAgents",
          label: "Remember agents",
          description: "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
          currentValue: getRememberAgents() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "cacheRetention",
          label: "Prompt cache retention",
          description:
            "Prompt cache lifetime for subagent model calls: short (5 min on Anthropic), long (1 hour), none, "
            + "or inherit (pi's default, incl. PI_CACHE_RETENTION). An agent's cache_retention frontmatter overrides it; "
            + "the main session is unaffected. Applies to agents started after the change",
          currentValue: getCacheRetention(),
          values: ["inherit", "short", "long", "none"],
        },
        {
          id: "packageAgents",
          label: "Package agents",
          description: describeGateSetting(
            getPackageAgentsGate(),
            "Load agents declared by installed pi packages (`pi.subagents.agents` in their package.json). "
            + "They rank below your global and project agents, so a same-named local file always wins.",
          ),
          currentValue: gateAdmitsAnything(getPackageAgentsGate()) ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "strictAgentFiles",
          label: "Strict agent files",
          description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
          currentValue: strictAgentFiles ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "outputTranscript",
          label: "Output transcript",
          description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
          currentValue: getOutputTranscriptDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "widgetMode",
          label: "Widget",
          description: "Above-editor agent widget: all = every agent; off = hide the widget.",
          currentValue: getWidgetMode(),
          values: ["all", "off"],
        },
        {
          id: "fleetView",
          label: "Fleet view",
          description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
          currentValue: isFleetViewEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showModel",
          label: "Show model",
          description:
            "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows and the fleet view rows. The Agent tool result and the conversation viewer show the pair either way — this adds it where the rows are already dense.",
          currentValue: isShowModelEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showCost",
          label: "Show cost",
          description:
            "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
          currentValue: isShowCostEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "viewerMarkdown",
          label: "Viewer markdown",
          description:
            "How much of the conversation viewer renders as Markdown. assistant = assistant text only (default); all = tool results too, for tools that emit Markdown — accepting that a Markdown pass over a diff or a log eats `#` comments, swallows a `---` line and re-fences indented output; off = everything verbatim. `m` in the viewer cycles the same setting (footer: raw / md / md+).",
          currentValue: getViewerMarkdown(),
          values: ["off", "assistant", "all"],
        },
        {
          id: "reportUsage",
          label: "Report usage to session",
          description:
            "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
          currentValue: isReportUsageEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      // The file the page is switched to. A typed row also names its setting:
      // retyping the value in effect must still reach a file that stores a
      // different one. Toggle and cycling rows always change their value.
      const target: SettingsTarget = {
        scope,
        key: isNumericSettingKey(id) ? id : undefined,
      };
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, target, `Max background concurrency set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, target, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, target, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, target, `Grace turns set to ${n}`);
        }
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, target, `Default join mode set to ${value}`);
      } else if (id === "schedulingEnabled") {
        const enabled = value === "on";
        if (enabled === isSchedulingEnabled()) {
          ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
        } else {
          setSchedulingEnabled(enabled);
          if (!enabled) scheduler.stop();  // immediate kill — outstanding fires stop ticking
          notifyApplied(
            ctx,
            target,
            `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, target, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "strictAgentFiles") {
        const enabled = value === "on";
        strictAgentFiles = enabled;
        notifyApplied(ctx, target, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`);
      } else if (id === "fallbackSubagent") {
        setFallbackSubagent(value);
        notifyApplied(
          ctx,
          target,
          value === NO_FALLBACK
            ? "Unknown or disabled agent types will now be rejected"
            : `Unknown agent types will fall back to ${value}`,
        );
      } else if (id === "outputTranscript") {
        const enabled = value === "on";
        setOutputTranscriptDefault(enabled);
        notifyApplied(ctx, target, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
      } else if (id === "worktreeIsolation") {
        const enabled = value === "on";
        setWorktreeIsolationEnabled(enabled);
        // The refusal is live, but the tool schema is built at registration, so
        // the isolation parameter only appears/disappears next session.
        notifyApplied(
          ctx,
          target,
          `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
        );
      } else if (id === "packageAgents") {
        const enabled = value === "on";
        const previous = getPackageAgentsGate();
        setPackageAgentsGate(enabled);
        reloadCustomAgents();
        // An allowlist cannot be expressed by an on/off row, so say plainly that
        // it is gone rather than letting a toggle quietly widen the gate.
        const replaced = Array.isArray(previous) && previous.length > 0
          ? ` Replaced the allowlist (${previous.join(", ")}) — re-add it in .pi/subagents.json to narrow it again.`
          : "";
        // Same caveat every row that changes the advertised agent set carries:
        // the `Agent` tool's description and schema are built at registration,
        // so until the next session the model is reading a stale type list.
        const specNote = " Tool spec change takes effect on next pi session.";
        notifyApplied(ctx, target, `Package agents ${enabled ? "enabled" : "disabled"}.${replaced}${specNote}`);
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, target, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "reportUsage") {
        const enabled = value === "on";
        setReportUsage(enabled);
        notifyApplied(
          ctx,
          target,
          enabled
            ? "Subagent usage now counted in this session's totals"
            : "Subagent usage no longer counted in this session's totals",
        );
      } else if (id === "showCost") {
        const enabled = value === "on";
        setShowCost(enabled);
        notifyApplied(ctx, target, `Cost display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "showModel") {
        const enabled = value === "on";
        setShowModel(enabled);
        notifyApplied(ctx, target, `Model display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "viewerMarkdown") {
        setViewerMarkdown(value as ViewerMarkdownMode);
        notifyApplied(ctx, target, `Viewer markdown set to ${value}`);
      } else if (id === "fleetView") {
        const enabled = value === "on";
        setFleetViewEnabled(enabled);
        notifyApplied(ctx, target, `Fleet view ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "agentMentions") {
        const mode = value as AgentMentionMode;
        setAgentMentionMode(mode);
        notifyApplied(
          ctx,
          target,
          mode === "off"
            ? "Agent mentions disabled"
            : mode === "model"
              ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
              : "Agent mentions on — a mentioned agent starts here, with no model call",
        );
      } else if (id === "rememberAgents") {
        const enabled = value === "on";
        setRememberAgents(enabled);
        notifyApplied(ctx, target, `Remember agents ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "cacheRetention") {
        setCacheRetention(value as CacheRetentionSetting);
        notifyApplied(ctx, target, `Prompt cache retention set to ${value}`);
      } else if (id === "widgetMode") {
        setWidgetMode(value as WidgetMode);
        notifyApplied(ctx, target, `Widget set to ${value}`);
      }
    }

    // Remove the row's setting from the file its tag names. The row then
    // shows what a restart would load: the other file's value, or the default.
    const resetRow = (id: string) => {
      const key = settingKeyOf(id);
      const row = () => buildItems().find(item => item.id === id);
      const label = row()?.label ?? id;
      const cwd = process.cwd();
      const source = settingSources(cwd)[key];
      if (!source) {
        ctx.ui.notify(`${label} is already at its default`, "info");
        return;
      }
      if (!saveSettings({ [key]: undefined } as SubagentsSettings, cwd, source)) {
        ctx.ui.notify(`${label}: failed to remove it from ${source} settings`, "warning");
        return;
      }
      resetSetting(key, loadSettings(cwd)[key] ?? SETTING_DEFAULTS[key]);
      // The file now agrees with memory for this key; a later save must not write it back.
      const snapshot = snapshotSettings();
      savedSnapshot = { ...savedSnapshot, [key]: snapshot[key] };
      pi.events.emit("subagents:settings_changed", { settings: snapshot, persisted: true });
      const still = settingSources(cwd)[key];
      const value = row()?.currentValue;
      ctx.ui.notify(
        still
          ? `${label} is now ${value} from ${still} settings (removed from ${source} settings)`
          : `${label} reset to the default, ${value} (removed from ${source} settings)`,
        "info",
      );
    };

    const deps: SettingsPageDeps = {
      buildItems,
      fileTags: () => {
        const sources = settingSources(process.cwd());
        return id => sources[settingKeyOf(id)];
      },
      apply: applyValue,
      reset: resetRow,
      header: () => {
        const path = settingsFilePath(scope, process.cwd());
        const shown = scope === "project" ? ".pi/subagents.json" : path.replace(homedir(), "~");
        const created = scope === "project" && !existsSync(path) ? " · created on first change" : "";
        return { scope, file: `${shown}${created}` };
      },
      toggleScope: () => {
        scope = scope === "global" ? "project" : "global";
      },
    };
    await ctx.ui.custom<undefined>((tui, theme, kb, done) => createSettingsPage(deps, tui, theme, kb, () => done(undefined)));
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  /**
   * Persist + broadcast the settings, silent on success — for a change whose
   * feedback is the UI it just changed: the viewer's `m` key, where a
   * notification per press would talk over the overlay it is describing.
   *
   * A *failed* write still speaks. Every other settings path warns when the
   * value is session-only, and swallowing it here would leave a preference
   * looking persisted when the next session will not have it.
   */
  function persistSettings(ctx: ExtensionCommandContext | undefined, changeMsg: string): void {
    const { message, level } = saveSnapshot(changeMsg);
    // `ctx` is absent only on the fleet path between sessions, where
    // `currentCtx` has been cleared and there is no UI to carry the warning to.
    // The write still happens.
    if (level === "warning") ctx?.ui.notify(message, level);
  }

  function notifyApplied(ctx: ExtensionCommandContext, target: SettingsTarget, successMsg: string) {
    const { message, level } = saveSnapshot(successMsg, target);
    ctx.ui.notify(message, level);
  }

  const { showAgentsMenu } = createAgentsMenu({
    pi,
    manager,
    scheduler,
    reloadCustomAgents,
    getModelLabel,
    viewAgentConversation,
    showSettings,
  });
  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
