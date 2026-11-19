/**
 * types.ts — Type definitions for the subagent system.
 */

import type { CacheRetention, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: the name of a custom role. */
export type SubagentType = string;

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/**
 * Isolation mode for agent execution.
 *
 * `"off"` exists for the caller's benefit, not the runtime's: models that fill
 * every optional parameter had no legal way to decline a single-value
 * `isolation` field and kept spawning worktrees they had just reasoned their
 * way out of (#231, #184). It is an input spelling only —
 * `resolveAgentInvocationConfig` collapses it to `undefined`, so nothing
 * downstream sees a value other than `"worktree"`. In an agent file it is a
 * genuine veto, since agent config outranks tool-call params.
 */
export type IsolationMode = "worktree" | "off";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  /** UI name. `display_name` wins; Claude Code's `name` is accepted as a fallback. */
  displayName?: string;
  /** Claude Code-compatible name color (named color or #RRGGBB). */
  color?: string;
  description: string;
  builtinToolNames?: string[];
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Bare `mcp__` entries from the `tools:` CSV (exact names or `*` patterns), as in
   * pi's `--tools`: MCP tools are narrowed to the matching ones. */
  mcpToolPatterns?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Persist this subagent as a normal pi session instead of keeping it in memory only. */
  persistSession?: boolean;
  /** Prompt-cache retention for this agent's model calls; overrides the `cacheRetention` setting. */
  cacheRetention?: CacheRetention;
  /** Write the subagent's .output transcript. Defaults to true; false suppresses only that transcript. */
  outputTranscript?: boolean;
  /** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
  sessionDir?: string;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /**
   * Isolation mode — "worktree" runs the agent in a temporary git worktree,
   * "off" refuses one even when the caller asks (frontmatter outranks params).
   */
  isolation?: IsolationMode;
  /** false = agent is listed but cannot be spawned */
  enabled?: boolean;
  /**
   * Where this agent was loaded from. `"package"` means an installed pi package
   * declared it (see package-resources.ts) — those files live under pi's install
   * root, so `/agents` treats them as read-only and offers Eject instead of Edit.
   */
  source?: "project" | "global" | "package";
  /** Path of the .md it was loaded from. */
  sourcePath?: string;
}

export type JoinMode = 'async' | 'group' | 'smart';

export type WidgetMode = "all" | "off";

/**
 * Prompt-cache retention for subagent model calls: pi's own values, plus
 * `inherit` (the global setting only) to leave pi's default — including its
 * `PI_CACHE_RETENTION` environment variable — in charge.
 */
export type CacheRetentionSetting = CacheRetention | 'inherit';

/**
 * How much of the conversation viewer's transcript is rendered as Markdown.
 * - `off`: every line wraps as literal text, as it did before the mode existed.
 * - `assistant`: assistant text renders as Markdown; tool results stay verbatim
 *   and dim. The default, because assistant text *is* Markdown by contract
 *   while a tool result is arbitrary bytes — a Markdown pass over a log or a
 *   diff eats `#` from shell comments, swallows a `---` line into a setext
 *   heading, re-fences indented output and redraws `| a | b |` as a table.
 *   (Ordered-list renumbering is the one such rewrite actively suppressed —
 *   see `MARKDOWN_OPTIONS` — because it silently changes data, not layout.)
 * - `all`: tool results render as Markdown too, for tools that genuinely emit
 *   it (#210's `ctx_execute`), accepting the rewrites above on ones that don't.
 */
export type ViewerMarkdownMode = 'off' | 'assistant' | 'all';

/**
 * Names and session metadata retained after a record is evicted. The live record
 * is discarded after ~10 minutes, but the pi session it wrote is still on disk,
 * and this is the little that is needed to find and describe it again.
 */
export interface AgentTombstone {
  handle: string;
  alias?: string;
  id: string;
  type: SubagentType;
  description: string;
  /** Always set — a record with no session file is never tombstoned. */
  sessionFile: string;
  completedAt: number;
  /** The agent's work lived in a worktree that is now gone; reopening is refused. */
  worktreeLost?: boolean;
}

/**
 * What an agent reference resolved to: a record still in memory, or the remains of one
 * whose conversation can be reopened from disk.
 */
export type MentionResolution =
  | { kind: "live"; record: AgentRecord }
  | { kind: "tombstone"; entry: AgentTombstone };

export interface AgentRecord {
  id: string;
  type: SubagentType;
  /**
   * Tool-addressable name derived from the agent type and numbered when
   * handles collide (`explore`, `explore-2`).
   */
  handle?: string;
  /**
   * A second, memorable handle from the spawner's `name` (`auth-audit`), drawn
   * from the same namespace as `handle` so the two can never collide. The
   * type-derived handle remains valid for a named agent.
   */
  alias?: string;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /**
   * Removes the listener that stops this run when its caller's signal aborts.
   * At most one is armed at a time — queueing arms one, starting replaces it.
   */
  detachParentAbort?: () => void;
  groupId?: string;
  joinMode?: JoinMode;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /**
   * The agent's pi session file, when it was persisted (`persist_session`, or
   * the `rememberAgents` default). Captured so `Agent({ resume })` can reopen the
   * conversation after the record itself has been evicted; undefined for an
   * in-memory session, which leaves nothing to reopen.
   */
  sessionFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Usage from this agent's turns, shown in the fleet list. */
  ownUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /**
   * The validated `StructuredOutput` payload, as canonical JSON.
   *
   * Set only when the spawn asked for a schema. Separate from `result` because
   * `result` is prose for a reader — previewed in the widget, written to the
   * transcript, and appended to with the worktree branch note — and JSON that
   * has been appended to no longer parses.
   */
  structuredJson?: string;
  /** Whether the child needed the extra structured-output prompt. */
  structuredRetried?: boolean;
  /** Id of the main session that launched this agent. */
  rootSessionId?: string;
}

/**
 * What a session reports as its level: pi's `ThinkingLevel` plus the `"off"` a
 * model with thinking disabled reports. Display-only — spawning still takes a
 * `ThinkingLevel`, so this widening cannot leak into an invocation.
 */
export type EffectiveThinkingLevel = ThinkingLevel | "off";

export interface AgentInvocation {
  /** Short display name for tight rows, e.g. "haiku 4.5". Always set once known. */
  modelName?: string;
  /** Canonical `provider/id`, for surfaces with room to disambiguate providers. */
  modelId?: string;
  /** The level actually in effect, once a session exists to report one. */
  thinking?: EffectiveThinkingLevel;
  /**
   * What the caller asked for, kept only when they did not get it — pi clamped
   * the level to the model's capabilities, or an agent file's frontmatter
   * outranked the parameter (#182). The snapshot exists to answer "did the spawn
   * honor my instructions?" (#62), which it cannot do if the request is lost, so
   * neither `requested*` field is overwritten once set.
   */
  requestedThinking?: EffectiveThinkingLevel;
  /** The caller's `model` parameter, as written, when an agent file's pin won. */
  requestedModel?: string;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  isolation?: IsolationMode;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  /**
   * Estimated cost in USD, from pi's per-message `usage.cost.total`. Always
   * populated (0 when the model has no pricing); the renderer decides whether
   * to show it, per the `showCost` setting.
   */
  totalCost?: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/**
 * A subagent spawn registered to fire on a schedule.
 *
 * Stored at `<cwd>/.pi/subagent-schedules/<sessionId>.json`. Session-scoped:
 * survives `/resume` but resets on `/new`, mirroring pi-chonky-tasks.
 */
export interface ScheduledSubagent {
  id: string;
  /** Unique within store. Defaults to `description`. */
  name: string;
  description: string;
  /** Raw user input — cron expr | "+10m" | ISO | "5m". */
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  /** Computed at create time for interval/once. */
  intervalMs?: number;

  // spawn params (subset of Agent tool params; no inherit_context, no resume)
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;

  // state
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  /** Refreshed on every fire and on store load. */
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  /** For future migrations. */
  version: 1;
  jobs: ScheduledSubagent[];
}
