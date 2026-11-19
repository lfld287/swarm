/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 * Excess agents are queued and start as slots free up.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { worktreeLost } from "./agent-record-entry.js";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { assignHandle, handleBase } from "./handles.js";
import type { CompiledSchema } from "./json-schema.js";
import { describeModel } from "./model-resolver.js";
import type { AgentInvocation, AgentRecord, AgentTombstone, IsolationMode, MentionResolution, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
/**
 * Fired by `steer()` once a message is delivered or queued. Every steer path
 * goes through it except `steer_subagent` in index.ts, which awaits the
 * session directly.
 */
export type OnAgentSteered = (record: AgentRecord, message: string) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end` across agent spawns and resumes.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

const DEFAULT_MAX_CONCURRENT = 10;

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * resume of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps its previous handle —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   *
   * `id` keeps the evicted agent's id too, so the id the model already holds
   * names the reopened conversation (`Agent({ resume })`). A name is taken
   * back only while nothing else holds it — see `reclaimable`.
   */
  reclaim?: { id?: string; handle?: string; alias?: string };
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Skip the queue check for this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler so a fired job cannot be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /**
   * Make the child report through a `StructuredOutput` tool built from this
   * compiled schema.
   */
  structuredOutput?: CompiledSchema;
  /**
   * Tools denied to this spawn on top of the agent definition's own list.
   */
  disallowedTools?: string[];
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Last chance to look at an isolated agent's worktree, awaited immediately
   * before it is committed to a branch and removed.
   *
   * Exists because that removal happens inside the settle path, before
   * the completion callback: by the time a caller has the finished record, the
   * directory the child actually wrote in is gone. Anything that must inspect
   * or verify that tree has to run here or it silently inspects the main tree
   * instead.
   *
   * Fires only on the normal settle path, and only when a worktree was created.
   * Not on the error path and not on the stop-during-copy guard: those are
   * already failing, and delaying cleanup there would leak a copy for no gain.
   * A rejection is swallowed — the hook can never keep the worktree alive.
   */
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called when startup reaches the runner, with the tracked promise already set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options so a spawn that starts on queue drain still
   * reaches its original caller.
   */
  onSpawned?: (id: string) => void;
  /** Called when queued, with the number of queue entries ahead of it. */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Config-discovery root when it differs from the working directory. */
  configCwd?: string;
  /** Root session id for grouping transcripts. */
  rootSessionId?: string;
}

interface ResumeOptions {
  /**
   * Explicit turn limit for the resumed run: this, else the limit the agent
   * was spawned with, else its type's own `max_turns`, else the default —
   * counted afresh from the resume prompt (#368).
   */
  maxTurns?: number;
  /** Called at the end of each resumed turn with the count since the resume. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Called when the run starts (immediately or from the queue). Attach
   * per-run output streaming here so queued cancellation leaves no subscription.
   */
  onStarted?: () => void;
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    // Optional all the way down: on a pi without the getter, or a stubbed session from a
    // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
    if (runner?.hasHandlers?.("session_shutdown")) {
      // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
      // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
      // already torn down — one hung handler would leave a dead terminal.
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  // Always, even on timeout: disposal is what this function ultimately exists to do.
  try { session?.dispose?.(); } catch { /* ignore */ }
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private onSteered?: OnAgentSteered;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Every `record.promise` that has not settled yet. A settled promise stays on
   * its record, so this is what tells `isSettling` and `waitForSettled` a run is
   * over.
   */
  private unsettled = new Set<Promise<unknown>>();
  private disposed = false;

  /**
   * Evicted agents that can still be reached by name, keyed by handle. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private tombstones = new Map<string, AgentTombstone>();

  private queue: { record: AgentRecord; start: () => Promise<string> }[] = [];
  private running = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
    onSteered?: OnAgentSteered,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.onSteered = onSteered;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Validate, then accept an agent into the background queue and return its ID. */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    if (this.disposed) throw new Error("The subagent manager has shut down");
    assertValidSpawnCwd(options.cwd);
    if (typeof prompt !== "string") throw new Error("Agent prompt must be a string");
    if (typeof options.description !== "string") throw new Error("Agent description must be a string");
    if (options.signal != null && !(options.signal instanceof AbortSignal)) {
      throw new Error("SpawnOptions.signal must be an AbortSignal");
    }

    // A saved-session reopen may replace an earlier failed reopen of that same
    // file. It must never replace a live run or an existing session.
    const reclaimedId = options.reclaim?.id;
    if (reclaimedId !== undefined && this.agents.has(reclaimedId)
      && (options.resumeSessionFile === undefined || this.failedReopen(reclaimedId)?.sessionFile !== options.resumeSessionFile)) {
      throw new Error(`Agent ${reclaimedId} is still in memory, so it cannot be reopened from its saved session.`);
    }
    const id = reclaimedId ?? randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      // Reclaim the original handle while it is free, including its numbering.
      handle: this.reclaimable(options.reclaim?.handle, options.reclaim?.id)
        ?? assignHandle(handleBase(type), this.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: this.reclaimable(options.reclaim?.alias, options.reclaim?.id),
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      ownUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      invocation: options.invocation,
      rootSessionId: options.rootSessionId,
      // A reopen continues this file until its session says otherwise (a fork
      // gets its own, set at session creation). Seeded so a run that fails
      // before it has a session still names the conversation in its saved
      // record and tombstone: without it, the next resume would be refused as
      // never saved.
      sessionFile: options.resumeSessionFile,
    };
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      const taken = this.takenHandles();
      taken.add(record.handle);
      record.alias = assignHandle(handleBase(options.name), taken);
    }
    this.agents.set(id, record);
    const args: SpawnArgs = { pi, ctx, type, prompt, options };
    this.accept(record, () => this.startAgent(record, args), options);
    return id;
  }

  /** Both a new agent and a resume enter the same FIFO queue and run lifecycle. */
  private accept(record: AgentRecord, start: () => Promise<string>, options: {
    signal?: AbortSignal; bypassQueue?: boolean; onQueued?: SpawnOptions["onQueued"];
  }): void {
    this.armParentAbort(record, options.signal);
    if (!options.bypassQueue && this.running >= this.maxConcurrent) {
      this.queue.push({ record, start });
      // Side effects must not turn an accepted ID into a launch error.
      try { options.onQueued?.(record.id, this.queue.length - 1); } catch { /* ignore caller wiring errors */ }
      if (options.signal?.aborted) this.abort(record.id);
    } else {
      this.launch(record, start);
      if (options.signal?.aborted) this.abort(record.id);
    }
  }

  private launch(record: AgentRecord, start: () => Promise<string>): void {
    record.status = "running";
    record.startedAt = Date.now();
    this.running++;
    // Track startup, execution and cleanup under one promise. Reserve the slot
    // synchronously; start on the next microtask so callers can wire receipts,
    // grouping and transcripts before any child callbacks run.
    const promise = Promise.resolve()
      .then(() => record.status === "stopped" ? "" : start())
      .catch((err) => {
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        return record.result ?? "";
      })
      .finally(() => {
        this.running--;
        this.settleRun(record);
        this.drainQueue();
      });
    this.trackRun(record, promise);
  }

  /**
   * Stop `record` when its caller's `signal` aborts, replacing any listener an
   * earlier stage armed — at most one is live per record, so one call to
   * `detachParentAbort` cuts the run loose from its caller.
   */
  private armParentAbort(record: AgentRecord, signal: AbortSignal | undefined): void {
    this.detachParentAbort(record);
    if (signal == null) return;
    const onParentAbort = () => this.abort(record.id);
    signal.addEventListener("abort", onParentAbort, { once: true });
    record.detachParentAbort = () => signal.removeEventListener("abort", onParentAbort);
  }

  private detachParentAbort(record: AgentRecord): void {
    record.detachParentAbort?.();
    record.detachParentAbort = undefined;
  }

  /** Start the child, including any isolated worktree, inside the tracked run. */
  private async startAgent(record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs): Promise<string> {
    // A queued cwd can disappear after acceptance. This time the error is
    // recorded on the accepted ID rather than returned as a dispatch error.
    assertValidSpawnCwd(options.cwd);
    const customCwd = options.cwd ?? undefined;
    const baseCwd = customCwd ?? ctx.cwd;
    const id = record.id;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done BEFORE
    // the run is kicked off so a failure doesn't leave a half-running agent.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    // Resolve the agent file's `isolation:` here too, since RPC forwards only
    // its caller's value.
    // A reopen never gets a worktree, as in Claude Code: a fresh copy of HEAD
    // would not hold the earlier run's edits, and a reopen whose old worktree
    // held any is refused before it gets here (`reopenTarget`).
    const isolation = options.resumeSessionFile !== undefined
      ? undefined
      : getAgentConfig(type)?.isolation ?? options.isolation;
    let worktreeCwd: string | undefined;
    if (isolation === "worktree" && isWorktreeIsolationEnabled()) {
      const wt = await createWorktree(pi, baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
      // The widget's "worktree" tag reads this; only callers that resolve the
      // agent file themselves seed it.
      record.invocation ??= {};
      record.invocation.isolation = "worktree";
    }

    let result: Awaited<ReturnType<typeof runAgent>> | undefined;
    try {
      // A stop may have landed during worktree creation. Clean up the copy
      // without starting a child, then settle the stopped run as usual.
      if (record.status !== "running") return "";
      this.onStart?.(record);
      options.onSpawned?.(id);
      if (record.abortController?.signal.aborted) return "";
      result = await runAgent(ctx, type, prompt, {
        pi,
        agentId: id,
        model: options.model,
        maxTurns: options.maxTurns,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        thinkingLevel: options.thinkingLevel,
        structuredOutput: options.structuredOutput,
        disallowedTools: options.disallowedTools,
        resumeSessionFile: options.resumeSessionFile,
        // Worktree wins for the working dir (the agent must run in the copy —
        // which, with a custom cwd, was created from that target). Config stays
        // with the parent project when a caller-supplied cwd is in play; it must
        // stay undefined otherwise so plain worktree runs keep resolving config
        // (incl. relative extension paths and memory) inside the worktree copy.
        cwd: worktreeCwd ?? customCwd,
        // Set iff a worktree was created (see above) — names the directory the
        // copy came from, so the prompt can tell the agent not to work there.
        worktreeBase: worktreeCwd ? baseCwd : undefined,
        configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
        signal: record.abortController!.signal,
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options.onToolActivity?.(activity);
        },
        onTurnEnd: options.onTurnEnd,
        onTextDelta: (delta, text) => {
          // Preserve streamed text if the runner rejects rather than returning
          // its collected response and failure reason.
          record.result = text;
          options.onTextDelta?.(delta, text);
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          addUsage(record.ownUsage, usage);
          this.onUsage?.(record, usage);
          options.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options.onCompaction?.(info);
        },
        onSessionCreated: (session) => {
          record.session = session;
          // Capture now, while the session object exists: after eviction this
          // path is the only thing that can reopen the conversation, and an
          // in-memory session reports undefined, which correctly means
          // "nothing to come back to".
          // Optional chaining, not defensiveness for its own sake: this is the
          // only field read off the session at creation, so an older pi or a
          // stubbed session must degrade to "not resumable" rather than throw
          // and take the whole spawn down with it.
          record.sessionFile = session.sessionManager?.getSessionFile?.();
          // Same reason, different field: the model and thinking level are only
          // knowable once pi has resolved its defaults and clamped the level to
          // what the model supports. Writing them back here makes the record
          // authoritative, so every surface reads one place instead of each
          // re-deriving "session, else the request" for itself.
          if (session.model) {
            record.invocation ??= {};
            // Read the kept request first: a caller's level survives being clamped
            // AND, one line later, being replaced by the effective one.
            const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
            Object.assign(record.invocation, describeModel(session.model));
            // Guarded for the reason above: a session that reports no level keeps
            // the request rather than losing it. Overwriting unconditionally would
            // turn an older or stubbed session into a blank `thinking:` tag, which
            // is worse than the stale-but-true value it replaced.
            if (session.thinkingLevel) {
              record.invocation.thinking = session.thinkingLevel;
              if (requested && requested !== session.thinkingLevel) {
                record.invocation.requestedThinking = requested;
              }
            }
          }
          // Flush any steers that arrived before the session was ready
          if (record.pendingSteers?.length) {
            for (const msg of record.pendingSteers) {
              session.steer(msg).catch(() => {});
            }
            record.pendingSteers = undefined;
          }
          options.onSessionCreated?.(session);
        },
      });
      record.session = result.session;
      record.structuredJson = result.structuredJson;
      record.structuredRetried = result.structuredRetried;
      record.result = result.responseText;
    } finally {
      this.flushOutput(record);
      if (record.worktree) {
        if (result && options.onBeforeWorktreeCleanup) {
          try { await options.onBeforeWorktreeCleanup(record.worktree.path); } catch { /* never block cleanup */ }
        }
        const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
        record.worktreeResult = wtResult;
        if (wtResult.hasChanges && wtResult.branch) {
          const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
          record.result = (record.result ?? "") +
            `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
        }
      }
    }
    this.settleOutcome(record, { ...result, text: record.result ?? "" });
    return result.responseText;
  }

  /** Finalize once: called by the launched run's finally, or by queued cancel. */
  private settleRun(record: AgentRecord): void {
    this.detachParentAbort(record);
    record.pendingSteers = undefined;
    record.completedAt ??= Date.now();
    if (this.disposed) return;
    try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
  }

  private flushOutput(record: AgentRecord): void {
    try { record.outputCleanup?.(); } catch { /* ignore transcript side-effect errors */ }
    record.outputCleanup = undefined;
  }

  private drainQueue(): void {
    while (!this.disposed && this.running < this.maxConcurrent && this.queue.length > 0) {
      const { record, start } = this.queue.shift()!;
      this.launch(record, start);
    }
  }

  /** Accept a new run of an existing session, returning the same record and ID. */
  resume(id: string, prompt: string, signal?: AbortSignal, options: ResumeOptions = {}): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (!record?.session || record.status === "running" || record.status === "queued" || this.isSettling(id)) return undefined;

    record.resultConsumed = false;
    record.result = undefined;
    record.error = undefined;
    record.completedAt = undefined;
    record.promise = undefined;
    record.status = "queued";
    record.abortController = new AbortController();
    this.accept(record, () => this.startResume(record, prompt, options), { signal });
    return record;
  }

  /**
   * Write a run's outcome onto its record — a spawn's or a resume's, with one
   * precedence: an external stop keeps "stopped"; a hard abort (turn limit +
   * grace) is "aborted"; a failed final turn (a provider error pi resolved
   * instead of rejecting, #144) is an "error", not a completion with an empty
   * or stale result; otherwise "steered" or "completed". The run's text stays
   * available in every case.
   */
  private settleOutcome(
    record: AgentRecord,
    { text, failure, aborted, steered }: Awaited<ReturnType<typeof resumeAgent>>,
  ): void {
    if (record.status !== "stopped") {
      if (aborted) {
        record.status = "aborted";
      } else if (failure) {
        record.status = "error";
        record.error = failure;
      } else {
        record.status = steered ? "steered" : "completed";
      }
    }
    record.result = text;
  }

  private async startResume(record: AgentRecord, prompt: string, options: ResumeOptions): Promise<string> {
    this.onStart?.(record);
    try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }
    try {
      const outcome = await resumeAgent(record.session!, prompt, {
        type: record.type,
        maxTurns: options.maxTurns ?? record.invocation?.maxTurns,
        onTurnEnd: options.onTurnEnd,
        onTextDelta: (_delta, text) => { record.result = text; },
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options.onToolActivity?.(activity);
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          addUsage(record.ownUsage, usage);
          this.onUsage?.(record, usage);
          options.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options.onCompaction?.(info);
        },
        signal: record.abortController!.signal,
      });
      this.settleOutcome(record, outcome);
      return outcome.text;
    } finally {
      this.flushOutput(record);
    }
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued). Fires `onSteered` on either
   * accepted path, so the UI viewers and the RPC both report
   * the steer the same way without each emitting by hand. The steer tools
   * bypass this method because they await delivery.
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    this.onSteered?.(record, message);
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Allow retrying a saved-session reopen that failed early or was canceled in the queue. */
  failedReopen(id: string): AgentRecord | undefined {
    const record = this.agents.get(id);
    if ((record?.status === "error" || record?.status === "stopped") && !record.session && record.sessionFile && !this.isSettling(id)) return record;
    return undefined;
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    // Tombstones keep their names: a later Explore must take `explore-2`
    // rather than shadow the evicted agent in tool lookups.
    for (const entry of this.tombstones.values()) {
      taken.add(entry.handle);
      if (entry.alias) taken.add(entry.alias);
    }
    return taken;
  }

  /**
   * `name`, if a reopened agent can take it back. Within one activation that is
   * always so — tombstoned names are never allocated (`takenHandles`) — but a
   * resume after a reload reopens from the session's saved record, with no
   * tombstone holding the name, so a fresh agent may have taken it since. A
   * name held by a live record, or by another agent's tombstone, stays with
   * its holder and the reopened agent gets a fresh one.
   *
   * `id` is the agent being reopened, when it keeps its own: its tombstone is
   * the one holding the name, legitimately.
   */
  private reclaimable(name: string | undefined, id: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    for (const record of this.agents.values()) {
      if (record.id === id) continue;
      if (record.handle === name || record.alias === name) return undefined;
    }
    if (id !== undefined) {
      for (const entry of this.tombstones.values()) {
        if (entry.id !== id && (entry.handle === name || entry.alias === name)) return undefined;
      }
    }
    return name;
  }

  /**
   * Resolve an agent handle or alias case-insensitively, preferring a record
   * that can still be steered and otherwise the most recently started one.
   * Fall back to an exact id, then look among tombstones.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued") return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId) return { kind: "live", record: byId };
    // Only once nothing live answers: a tombstone is a conversation to reopen,
    // and reopening one while its record still exists would fork the session.
    for (const entry of this.tombstones.values()) {
      if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.status === "queued") {
      this.queue = this.queue.filter(entry => entry.record !== record);
      record.status = "stopped";
      this.settleRun(record);
      return true;
    }

    if (record.status !== "running") return false;
    // Keep the slot and tracked promise until startup/execution actually stops.
    record.status = "stopped";
    record.abortController?.abort();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.tombstone(record);
    const session = record.session;
    // Detached before the shutdown starts, so the record leaves the map at once and
    // nothing can observe a session that is half torn down.
    record.session = undefined;
    this.agents.delete(id);
    // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
    // and from `clearCompleted()` on session boundaries, with the process staying alive,
    // so handlers get their full window. The quit path awaits instead — see dispose().
    void shutdownChildSession(session);
  }

  /**
   * Preserve a departing record's names for tool lookup and session reopen.
   * Keep only records with both a handle and a persisted session file.
   */
  private tombstone(record: AgentRecord): void {
    if (!record.handle || !record.sessionFile) return;
    this.tombstones.set(record.handle, {
      handle: record.handle,
      alias: record.alias,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
      worktreeLost: worktreeLost(record) || undefined,
    });
    // Bound the memory a long session can accumulate. Oldest first, since the
    // agent someone still wants to reach is the one they used most recently.
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = [...this.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
      this.tombstones.delete(oldest.handle);
    }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || this.isSettling(id)) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || this.isSettling(id)) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. Tool lookups in the new session must not
    // resolve tombstones from the previous one.
    this.tombstones.clear();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    for (const id of this.agents.keys()) {
      if (this.abort(id)) count++;
    }
    return count;
  }

  /**
   * Resolve once this agent's startup and run have settled — true then, or
   * false if `timeoutMs` passes first. `abort()` marks a record "stopped" at
   * once, while a tool call
   * that ignores the signal can still be running (#443).
   *
   * Recheck after each pass in case a new run was accepted in the meantime.
   */
  async waitForSettled(id: string, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const settled = (async () => {
      for (let pending = this.unsettledFor(id); pending.length > 0; pending = this.unsettledFor(id)) {
        await Promise.allSettled(pending);
      }
      return true;
    })();
    try {
      return await Promise.race([settled, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether this agent is still starting up or running, regardless of status.
   * A stopped agent reads true until the tool call that ignored the abort ends.
   */
  isSettling(id: string): boolean {
    return this.unsettledFor(id).length > 0;
  }

  /** This agent's startup and run promises that have not settled yet. */
  private unsettledFor(id: string): Promise<unknown>[] {
    const pending: Promise<unknown>[] = [];
    const run = this.agents.get(id)?.promise;
    if (run && this.unsettled.has(run)) pending.push(run);
    return pending;
  }

  /** Set `record.promise`, and track it in `unsettled` until it settles. */
  private trackRun(record: AgentRecord, promise: Promise<string>): void {
    record.promise = promise;
    this.unsettled.add(promise);
    const done = () => { this.unsettled.delete(promise); };
    promise.then(done, done);
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    while (this.unsettled.size > 0) {
      await Promise.allSettled(this.unsettled);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.disposed = true;
    this.abortAll();
    const sessions = [...this.agents.values()].map(record => record.session);
    for (const record of this.agents.values()) this.detachParentAbort(record);
    this.agents.clear();
    this.unsettled.clear();
    if (pi) {
      // Prune any orphaned git worktrees (crash recovery). Detached: dispose runs
      // on the shutdown path, which cannot wait for git. Started before the awaited
      // shutdown below rather than after it, so the git calls have that window to
      // finish in instead of racing the process exit that follows.
      const prune = (repo: string) => { pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) prune(repo);
    }
    // Awaited, unlike the eviction path: pi awaits this extension's `session_shutdown`
    // handler and the process exits right after it returns, so anything left unawaited
    // here never runs at all. Bounded — each call carries its own ceiling, concurrently.
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
