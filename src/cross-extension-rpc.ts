/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, stop, consume, steer, get, and list RPCs over the
 * pi.events event bus, using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 *
 * @see docs/rpc.md — the caller-facing integration reference: spawn options
 * (including the fields spawnTopLevel strips), every error string, the
 * completion-notification race, and the protocol limitations.
 */

import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import { toSubagentInfo } from "./subagent-info.js";
import type { AgentRecord } from "./types.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 3;

/**
 * How long `subagents:rpc:stop` waits for the stopped agent to settle before
 * replying `{ settled: false }`. Below the 10 s pi-tasks
 * gives the stop reply, so a slow settle never reads to it as a failed stop.
 */
export const STOP_SETTLE_TIMEOUT_MS = 5_000;

/** The largest `settleTimeoutMs` a `subagents:rpc:stop` caller can ask for. */
export const STOP_SETTLE_TIMEOUT_MAX_MS = 60_000;

/**
 * What this build supports, on the `ping` reply. A consumer checks
 * `features.includes(...)` on the protocol version it supports.
 */
export const FEATURES = [
  "consume",
  "steer",
  "get",
  "list",
  "stop-settles",
  "settling",
  "notification-pending",
] as const;

/** Minimal AgentManager interface needed by the spawn/stop/consume RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
  /** Resolves true once the agent's startup and run have settled, false on timeout. */
  waitForSettled(id: string, timeoutMs: number): Promise<boolean>;
  /**
   * Whether the agent is still starting up or running,
   * whatever its status says — a stopped agent whose tool call ignored the
   * abort reads true until that call ends.
   */
  isSettling(id: string): boolean;
  /** The record behind an id, or undefined if it is not found. */
  getRecord(id: string): AgentRecord | undefined;
  /** Every record the manager holds, of any status. */
  listAgents(): AgentRecord[];
  /**
   * Whether the agent has settled but the parent has not been sent its
   * completion notification yet — still held for the parent's next boundary
   * or for its `group`. A notification that will start a parent turn.
   */
  isNotificationPending(id: string): boolean;
  /**
   * Mark a settled agent's result as read by the caller, suppressing the
   * completion notification — what `get_subagent_result` does when it returns
   * one. False when there is no such agent, or it has not settled yet.
   */
  consumeResult(id: string): boolean;
  /**
   * Deliver a message to a running or queued agent's conversation — what
   * `steer_subagent` does. False when the agent is unknown or has settled.
   */
  steer(id: string, message: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubConsume: () => void;
  unsubSteer: () => void;
  unsubGet: () => void;
  unsubList: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, stop, consume, steer, get, and list RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION, features: [...FEATURES] };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
      // forward serializable values, so options.model can be a string like
      // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
      // — same pattern the scheduler path already uses — so the spawned
      // agent's auth lookup doesn't crash with "No API key found for
      // undefined".
      let normalizedOptions = options ?? {};
      // `!= null` on purpose: a JSON-forwarding caller can serialize an unset
      // field as null, and the runner reads `options.model ?? default`, so null
      // means "inherit" — not an override to resolve or scope-check.
      const override = normalizedOptions.model;
      if (override != null) {
        const { modelRegistry, cwd } = ctx as { modelRegistry?: ModelRegistry; cwd?: string };
        // Names the override the same way in both messages below; an object
        // override would otherwise interpolate as "[object Object]".
        const label = typeof override === "string" ? override : `${override.provider}/${override.id}`;
        if (!modelRegistry) {
          throw new Error(`Model override "${label}" provided but ctx.modelRegistry is unavailable`);
        }
        let model = override;
        if (typeof override === "string") {
          const resolved = resolveModel(override, modelRegistry);
          if (typeof resolved === "string") {
            // resolveModel returns a human-readable error string when the
            // input doesn't match any available model. Surface it instead of
            // silently falling back so the caller sees the auth/typo issue.
            throw new Error(resolved);
          }
          model = resolved;
          normalizedOptions = { ...normalizedOptions, model: resolved };
        }

        // A model on the RPC payload is an orchestrator-level choice, exactly
        // like Agent({ model }) — so it gets the Agent tool's hard error, never
        // the frontmatter warn (#240). The check reads the RESOLVED model:
        // resolveModel is fuzzy, so a bare "sonnet" can land on a provider the
        // caller never named. Frontmatter-pinned and parent-inherited models are
        // resolved later, in agent-runner, and keep warn-and-proceed.
        const verdict = checkModelScope({
          model,
          cwd: cwd ?? process.cwd(),
          modelRegistry,
          callerSupplied: true,
          agentLabel: type,
          modelInput: label,
        });
        if (verdict.kind === "error") throw new Error(verdict.message);
      }

      const id = manager.spawn(pi, ctx, type, prompt, normalizedOptions);
      return { id, status: manager.getRecord(id)?.status };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string; settleTimeoutMs?: unknown }>(
    events, "subagents:rpc:stop", async ({ agentId, settleTimeoutMs }) => {
      if (settleTimeoutMs !== undefined && (typeof settleTimeoutMs !== "number" || !Number.isFinite(settleTimeoutMs))) {
        throw new Error("settleTimeoutMs must be a number of milliseconds");
      }
      const timeoutMs = Math.min(Math.max(settleTimeoutMs ?? STOP_SETTLE_TIMEOUT_MS, 0), STOP_SETTLE_TIMEOUT_MAX_MS);
      if (!manager.getRecord(agentId)) throw new Error("Agent not found");
      // `abort` returns false for a record that is neither running nor queued.
      // If it is still settling, this is a repeat stop after
      // `settled: false`, and it waits again. Otherwise the agent has finished:
      // not "not found", since the lookup above proved it exists.
      if (!manager.abort(agentId) && !manager.isSettling(agentId)) throw new Error("Agent is not running");
      // The reply waits for this agent's work to actually stop (#443).
      // If the bound passes first, `settled: false` says work may still be
      // running; `get` then shows `settling`.
      return { settled: await manager.waitForSettled(agentId, timeoutMs) };
    },
  );

  // A caller that has already shown the model an agent's result — pi-tasks'
  // TaskOutput is the one in practice — says so here, so the completion
  // notification for that same result is not delivered on top of it and does
  // not cost the parent a turn. Deliberately outside the ping version
  // handshake: an extension built against protocol v2 simply never calls it.
  const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:consume", ({ agentId }) => {
      if (!manager.consumeResult(agentId)) throw new Error("Agent not found or still running");
    },
  );

  // An extension that spawned an agent over the bus and then learns something
  // that agent needs — a second CI failure on the head it is already fixing, a
  // review that landed mid-run — can hand it over instead of spawning a second
  // agent for the same work or dropping the fact. Additive: a caller detects
  // it through `FEATURES` on ping, not the version.
  const unsubSteer = handleRpc<{ requestId: string; agentId: string; message: unknown }>(
    events, "subagents:rpc:steer", ({ agentId, message }) => {
      if (typeof message !== "string" || message.trim().length === 0) throw new Error("Steer message must be a non-empty string");
      if (!manager.getRecord(agentId)) throw new Error("Agent not found");
      if (!manager.steer(agentId, message)) throw new Error("Agent is not running");
    },
  );

  // Snapshots, for a listener that joined after the lifecycle events it needed
  // had already fired — bound late, or reloaded mid-run. Detected through
  // `FEATURES` on ping, like steer.
  //
  // Snapshots also say what the events cannot: `notificationPending`, set while
  // a settled agent's completion is still on its way to the parent. An
  // orchestrator that waits for "nothing active" must wait for it too, or the
  // notification starts a parent turn right after it concluded none would
  // (#103). Not on the events: `completed` fires before the notification is
  // queued, so there it would always read false.
  //
  // `settling` is set while a terminal agent still has work in flight — for
  // example, a stopped agent whose tool call ignored the abort (#443). The
  // terminal event fires from inside the settle path, so it omits this field.
  const snapshot = (record: AgentRecord, now?: number) => {
    const terminal = record.status !== "running" && record.status !== "queued";
    return {
      ...toSubagentInfo(record, now),
      ...(terminal && manager.isSettling(record.id) ? { settling: true } : {}),
      ...(manager.isNotificationPending(record.id) ? { notificationPending: true } : {}),
    };
  };

  const unsubGet = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:get", ({ agentId }) => {
      const record = manager.getRecord(agentId);
      if (!record) throw new Error("Agent not found");
      return { agent: snapshot(record) };
    },
  );

  const unsubList = handleRpc(events, "subagents:rpc:list", () => {
    const now = Date.now();
    return { agents: manager.listAgents().map(record => snapshot(record, now)) };
  });

  return {
    unsubPing, unsubSpawn, unsubStop, unsubConsume, unsubSteer, unsubGet, unsubList,
  };
}
