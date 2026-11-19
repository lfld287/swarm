import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { createWorktree, isWorktreeIsolationEnabled } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — acceptance and completion callbacks", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("calls onSpawned for the queued ID before the child's session callback", async () => {
    manager = new AgentManager(undefined, 1);
    const first = Promise.withResolvers<Awaited<ReturnType<typeof runAgent>>>();
    const complete = { responseText: "done", session: mockSession(), aborted: false, steered: false };
    const order: string[] = [];
    vi.mocked(runAgent).mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts) => {
        opts.onSessionCreated?.(complete.session);
        return complete;
      });
    manager.spawn(mockPi, mockCtx, "worker", "first", { description: "first" });
    const id = manager.spawn(mockPi, mockCtx, "worker", "second", {
      description: "second",
      onQueued: (accepted, ahead) => { order.push(`queued:${accepted}:${ahead}`); },
      onSpawned: (started) => {
        expect(manager.getRecord(started)?.promise).toBeDefined();
        order.push(`spawned:${started}`);
      },
      onSessionCreated: () => { order.push("session"); },
    });
    expect(order).toEqual([`queued:${id}:0`]);
    first.resolve(complete);
    await manager.waitForAll();
    expect(order).toEqual([`queued:${id}:0`, `spawned:${id}`, "session"]);
    expect(manager.getRecord(id)).toMatchObject({ status: "completed", result: "done" });
    expect(manager.getRecord(id)?.resultConsumed).toBeFalsy();
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // With maxConcurrent=1, the first agent runs and the second is queued.
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) still removes running=false queued=false records when resultConsumed=false for error status", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    // Error records with unread results are also preserved — the LLM should
    // be able to read the error message via get_subagent_result before the
    // record is evicted.
    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });


});

// The manager-level usage hook is the ONE place every assistant message is seen
// exactly once, which is what parent-session accounting (#193) is built on.
describe("AgentManager — the usage hook fires once per assistant message", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("fires once per message, with the same delta the record accumulates", async () => {
    const seen: any[] = [];
    manager = new AgentManager(undefined, undefined, undefined, undefined, (r, u) => seen.push({ id: r.id, u }));
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20, cost: 0.02 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(seen.map(s => s.u)).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cost: 0.01 },
      { input: 200, output: 80, cacheWrite: 20, cost: 0.02 },
    ]);
    expect(seen.every(s => s.id === id)).toBe(true);
  });

});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0, cost: 0 });
    expect(record.ownUsage).toEqual({ input: 0, output: 0, cacheWrite: 0, cost: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20, cost: 0.02 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30, cost: 0.03,
    });
  });

  // A callback may read the live record, so it must already include the event.
  it("updates the record before forwarding a spawn's activity and usage hooks", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // A real child does work first; by then spawn() has returned the id.
      await new Promise(resolve => setTimeout(resolve, 0));
      opts.onToolActivity?.({ type: "end", toolName: "read" });
      opts.onAssistantUsage?.({ input: 100, output: 20, cacheWrite: 0, cost: 0 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });
    const seen: { toolUses?: number; output?: number }[] = [];
    let id = "";
    const read = () => {
      const record = manager.getRecord(id);
      seen.push({ toolUses: record?.toolUses, output: record?.lifetimeUsage.output });
    };

    id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      onToolActivity: read,
      onAssistantUsage: read,
    });
    await manager.getRecord(id)!.promise;

    expect(seen).toEqual([{ toolUses: 1, output: 0 }, { toolUses: 1, output: 20 }]);
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0, cost: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5, cost: 0.007 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { text: "second" };
    });

    await manager.resume(id, "more")?.promise;

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5, cost: 0.007 });
    expect(manager.getRecord(id)!.ownUsage).toEqual({ input: 70, output: 30, cacheWrite: 5, cost: 0.007 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });

  // #368 — a resumed run is bounded like a spawn, so its outcome must map the
  // same way: a hard abort is "aborted", a wrap-up is "steered".
  describe("resume() turn-limit outcome (#368)", () => {
    async function spawnSettled() {
      manager = new AgentManager();
      vi.mocked(runAgent).mockResolvedValue({
        responseText: "first",
        session: mockSession() as any,
        aborted: false,
        steered: false,
      });
      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test" });
      await manager.getRecord(id)!.promise;
      return id;
    }

    it("hands the record's type, the explicit limit and the turn counter to the runner", async () => {
      const id = await spawnSettled();
      vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });
      const onTurnEnd = vi.fn();

      await manager.resume(id, "more", undefined, { maxTurns: 3, onTurnEnd })?.promise;

      const opts = vi.mocked(resumeAgent).mock.calls.at(-1)![2]!;
      expect(opts.type).toBe("general-purpose");
      expect(opts.maxTurns).toBe(3);
      expect(opts.onTurnEnd).toBe(onTurnEnd);
    });

    it("falls back to the limit the agent was spawned with when the caller passes none", async () => {
      manager = new AgentManager();
      vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: mockSession() as any, aborted: false, steered: false });
      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        invocation: { maxTurns: 50 },
      });
      await manager.getRecord(id)!.promise;
      vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

      await manager.resume(id, "more")?.promise;
      expect(vi.mocked(resumeAgent).mock.calls.at(-1)![2]!.maxTurns).toBe(50);

      await (await manager.resume(id, "again"))!.promise;
      expect(vi.mocked(resumeAgent).mock.calls.at(-1)![2]!.maxTurns).toBe(50);
    });

    it("abort() reaches the resumed run and the record stays stopped", async () => {
      const id = await spawnSettled();
      let runSignal: AbortSignal | undefined;
      let finish!: () => void;
      vi.mocked(resumeAgent).mockImplementation((_s, _p, opts) => {
        runSignal = opts.signal;
        return new Promise((resolve) => { finish = () => resolve({ text: "partial", aborted: false, steered: false }); });
      });

      const resumed = manager.resume(id, "more");
      await Promise.resolve();
      expect(manager.abort(id)).toBe(true);
      expect(runSignal?.aborted).toBe(true);

      finish();
      await resumed?.promise;
      expect(manager.getRecord(id)!.status).toBe("stopped");
      expect(manager.getRecord(id)!.result).toBe("partial");
    });

    it("a caller signal that is already aborted stops the resume before it runs", async () => {
      const id = await spawnSettled();
      vi.mocked(resumeAgent).mockClear();

      const cancelled = new AbortController();
      cancelled.abort();
      await manager.resume(id, "more", cancelled.signal)?.promise;

      expect(manager.getRecord(id)!.status).toBe("stopped");
      expect(resumeAgent).not.toHaveBeenCalled();
    });

    it("a steered resume ends steered, an aborted one aborted", async () => {
      const id = await spawnSettled();

      vi.mocked(resumeAgent).mockResolvedValue({ text: "wrapped", aborted: false, steered: true });
      await manager.resume(id, "more")?.promise;
      expect(manager.getRecord(id)!.status).toBe("steered");
      expect(manager.getRecord(id)!.result).toBe("wrapped");

      vi.mocked(resumeAgent).mockResolvedValue({ text: "cut", aborted: true, steered: true });
      await manager.resume(id, "again")?.promise;
      expect(manager.getRecord(id)!.status).toBe("aborted");
      expect(manager.getRecord(id)!.result).toBe("cut");
    });


  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("keeps the accepted ID and completes exactly once when worktree startup fails", async () => {
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined);
    vi.mocked(runAgent).mockClear();
    const completed = vi.fn();
    manager = new AgentManager(completed);
    const id = manager.spawn(mockPi, mockCtx, "worker", "test", { description: "test", isolation: "worktree" });
    expect(manager.getRecord(id)?.status).toBe("running");
    await manager.waitForAll();
    const record = manager.getRecord(id);
    expect(record).toMatchObject({ status: "error", error: expect.stringContaining('isolation: "worktree"') });
    expect(completed).toHaveBeenCalledExactlyOnceWith(record);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("never builds a worktree for a reopened conversation", async () => {
    // As in Claude Code: a fresh copy of HEAD would not hold the earlier run's
    // edits, so a reopen runs where it is started instead.
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockClear();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: mockSession(), aborted: false, steered: false } as never);

    manager = new AgentManager();
    manager.spawn(mockPi, mockCtx, "general-purpose", "continue", {
      description: "reopen",
      isolation: "worktree",
      resumeSessionFile: "/sessions/child.jsonl",
    });
    await manager.waitForAll();

    expect(createWorktree).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent).mock.lastCall![3].cwd).toBeUndefined();
  });

  it("keeps the concurrency slot accounting straight while the worktree is being created", async () => {
    // The slot is claimed before the awaited copy, so drainQueue can't read a
    // stale runningBackground and start every queued agent at once — and it is
    // given back if the copy fails, or the queue would be stuck forever.
    const { createWorktree } = await import("../src/worktree.js");
    let releaseCopy!: () => void;
    vi.mocked(createWorktree).mockImplementationOnce(
      () => new Promise(resolve => { releaseCopy = () => resolve(undefined); }),
    );
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager(undefined, 1);
    const slowId = manager.spawn(mockPi, mockCtx, "X", "slow", {
      description: "slow", isolation: "worktree",
    });
    const queuedId = manager.spawn(mockPi, mockCtx, "X", "queued", {
      description: "queued",
    });

    // The slot is taken while the copy is still in flight.
    expect(manager.getRecord(queuedId)!.status).toBe("queued");
    expect(runAgent).not.toHaveBeenCalled();

    await Promise.resolve();
    releaseCopy();
    await manager.getRecord(slowId)?.promise;
    expect(manager.getRecord(slowId)).toMatchObject({ status: "error", error: expect.stringContaining('isolation: "worktree"') });
    await manager.getRecord(queuedId)!.promise;

    // Slot released on failure — the queued agent got to run.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(queuedId)!.status).toBe("completed");
  });

  it("keeps a structured payload parseable when the worktree note is appended", async () => {
    // `record.result` is prose for a reader and picks up a branch note on the
    // way out. A schema'd payload living in the same field would stop parsing
    // for every `agent({ schema, isolation: "worktree" })` call.
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    const wt = { path: "/wt/a", branch: "pi-agent-a", baseSha: "abc", workPath: "/wt/a" };
    vi.mocked(createWorktree).mockResolvedValueOnce(wt as never);
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: true, branch: "pi-agent-a" } as never);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "I edited two files",
      session: mockSession(),
      aborted: false,
      steered: false,
      structuredJson: '{"answer":"42"}',
    } as never);

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "go", {
      description: "go", isolation: "worktree",
    });
    await manager.getRecord(id)?.promise;
    await vi.waitFor(() => expect(manager.getRecord(id)!.status).toBe("completed"));

    const record = manager.getRecord(id)!;
    expect(JSON.parse(record.structuredJson!)).toEqual({ answer: "42" });
    // The note still reaches the prose, which is where a human reads it.
    expect(record.result).toContain("Changes saved to branch");
  });

  it("a stop that lands during the copy discards the worktree instead of running", async () => {
    // Window that did not exist when creation was synchronous: abort() can mark
    // the record stopped while the repo is still being copied.
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    let releaseCopy!: () => void;
    const wt = { path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy" };
    vi.mocked(createWorktree).mockImplementationOnce(
      () => new Promise(resolve => { releaseCopy = () => resolve(wt); }),
    );
    vi.mocked(cleanupWorktree).mockClear();
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "stopped", {
      description: "stopped", isolation: "worktree",
    });
    await Promise.resolve();
    expect(manager.abort(id)).toBe(true);

    releaseCopy();
    await manager.getRecord(id)?.promise;

    expect(runAgent).not.toHaveBeenCalled();
    expect(cleanupWorktree).toHaveBeenCalledWith(mockPi, "/tmp", wt, "stopped");
    expect(manager.getRecord(id)!.status).toBe("stopped");
  });
});

// The worktree is committed to a branch and deleted inside the settle path, so
// a caller holding the finished record can no longer see what the child wrote.
// `onBeforeWorktreeCleanup` is the one window where it still exists.
describe("AgentManager — onBeforeWorktreeCleanup", () => {
  let manager: AgentManager;
  const wt = { path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy" };

  /** Records call order across the hook and the (mocked) cleanup. */
  async function trace() {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    const order: string[] = [];
    vi.mocked(createWorktree).mockResolvedValue(wt);
    vi.mocked(cleanupWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockImplementation(async () => {
      order.push("cleanup");
      return { hasChanges: false };
    });
    return { order, cleanupWorktree: vi.mocked(cleanupWorktree) };
  }

  afterEach(async () => {
    manager?.dispose();
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockImplementation(async () => ({ hasChanges: false }));
  });

  it("fires with the worktree path, before the worktree is cleaned up", async () => {
    const { order } = await trace();
    resolvedRun();
    const seen: string[] = [];

    manager = new AgentManager();
    manager.spawn(mockPi, mockCtx, "X", "test", {
      description: "test",
      isolation: "worktree",
      onBeforeWorktreeCleanup: async (path) => {
        order.push("hook");
        seen.push(path);
      },
    });

    await manager.waitForAll();
    expect(seen).toEqual(["/wt/copy"]);
    // Order is the whole point: after cleanup the path is a branch, not a tree.
    expect(order).toEqual(["hook", "cleanup"]);
  });

  it("cleans up anyway when the hook throws", async () => {
    const { order } = await trace();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "test", {
      description: "test",
      isolation: "worktree",
      onBeforeWorktreeCleanup: async () => {
        order.push("hook");
        throw new Error("gate blew up");
      },
    });

    await manager.getRecord(id)?.promise;
    const record = manager.getRecord(id)!;
    // A hook that fails must not leak a worktree, and must not fail the agent.
    expect(order).toEqual(["hook", "cleanup"]);
    expect(record.status).toBe("completed");
  });

  it("does not fire on the error path, which still cleans up", async () => {
    const { order } = await trace();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "test", {
      description: "test",
      isolation: "worktree",
      onBeforeWorktreeCleanup: async () => {
        order.push("hook");
      },
    });

    await manager.getRecord(id)?.promise;
    const record = manager.getRecord(id)!;
    expect(order).toEqual(["cleanup"]);
    expect(record.status).toBe("error");
  });

  it("does not fire for a stop that lands while the repo is still being copied", async () => {
    // That path discards a worktree the child never wrote in, so there is
    // nothing to inspect and nothing may delay the discard.
    const { createWorktree } = await import("../src/worktree.js");
    const { order } = await trace();
    let releaseCopy!: () => void;
    vi.mocked(createWorktree).mockImplementationOnce(
      () => new Promise(resolve => { releaseCopy = () => resolve(wt); }),
    );
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "stopped", {
      description: "stopped",
      isolation: "worktree",
      onBeforeWorktreeCleanup: async () => {
        order.push("hook");
      },
    });
    await Promise.resolve();
    expect(manager.abort(id)).toBe(true);
    releaseCopy();
    await manager.getRecord(id)?.promise;

    expect(order).toEqual(["cleanup"]);
  });

  it("does not fire for an agent that has no worktree", async () => {
    const { order } = await trace();
    resolvedRun();

    manager = new AgentManager();
    manager.spawn(mockPi, mockCtx, "X", "test", {
      description: "test",
      onBeforeWorktreeCleanup: async () => {
        order.push("hook");
      },
    });

    expect(order).toEqual([]);
  });
});

// The project switch has to bite below the tool boundary: cross-extension RPC
// forwards its options straight to spawn(), so a schema that omits the
// isolation parameter can't stop a caller that never saw the schema (#184).
describe("AgentManager — worktreeIsolation: false refuses worktrees", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
  });

  it("creates no worktree for an RPC-shaped spawn when the project disabled it", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockClear();
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(false);

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });

    // Downgraded, not rejected — the user opted out, so the call still runs.
    expect(createWorktree).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.worktree).toBeUndefined();
  });

  it("does not mask a genuine worktree failure while enabled", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined);
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);

    manager = new AgentManager();
    // The refusal above is silent, but a real failure still surfaces — through
    // the accepted record rather than a throw out of spawn(), since copying is
    // an awaited git call.
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)).toMatchObject({ status: "error", error: expect.stringContaining('isolation: "worktree"') });
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/packages/api",
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    // The run only exists once the copy does — the agent is not running when
    // spawn() returns under worktree isolation.
    await manager.getRecord(id)?.promise;
    await manager.getRecord(id)!.promise;

    expect(createWorktree).toHaveBeenCalledWith(mockPi, "/", id);
    // Worktree wins for the working dir — at workPath, so subdirectory scoping
    // survives isolation. Config still anchored to the parent.
    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp", worktreeBase: "/" }),
    );
    expect(cleanupWorktree).toHaveBeenCalledWith(mockPi, "/", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    // Parent session sitting in a repo subdirectory: workPath would point at
    // the copied subdir. Without SpawnOptions.cwd the agent must stay at the
    // copy's root — moving it would also move .pi config discovery.
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/sub/dir",
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecord(id)?.promise;
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.configCwd).toBeUndefined();
    // The copy came from the parent session's cwd — that is what the prompt
    // must name as off-limits (#187).
    expect(opts.worktreeBase).toBe("/tmp");
  });

  it("no worktree — no worktreeBase, so no isolation block in the prompt", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test" });
    await manager.getRecord(id)!.promise;

    expect(vi.mocked(runAgent).mock.lastCall![3].worktreeBase).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block" });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", async () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    await Promise.resolve();
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeUndefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // aborted:false, as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    await Promise.resolve();
    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    // The agent loop ends and the promise settles "normally".
    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");        // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
  });
});

describe("AgentManager — steer()", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.steer("nope", "hi")).toBe(false);
  });

  it("delivers to a live session via session.steer()", async () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    await Promise.resolve();
    // Simulate the session becoming ready.
    captured?.({ steer, dispose: vi.fn() });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r" });
    const record = manager.getRecord(id)!;
    record.session = undefined; // not ready

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("refuses to steer an agent that is no longer running", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(manager.steer(id, "too late")).toBe(false);
  });
});

describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.abortController?.signal.aborted).toBe(true);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r" });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q" });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

// #144 — a run that RESOLVES with a failed final turn (pi never rejects on
// retry exhaustion) must map to status "error", not "completed".
describe("AgentManager — resolved runs with a failed final turn map to error (#144)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  const failedRun = (failure: string, responseText = "") =>
    vi.mocked(runAgent).mockResolvedValue({
      responseText,
      session: mockSession(),
      aborted: false,
      steered: false,
      failure,
    } as any);

  it("sets status='error' and captures the provider message", async () => {
    manager = new AgentManager();
    failedRun("retries exhausted: 529 overloaded");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted: 529 overloaded");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("keeps earlier-turn text available as result context, but never as a clean completion", async () => {
    manager = new AgentManager();
    failedRun("provider died", "partial progress from an earlier turn");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("partial progress from an earlier turn");
  });

  it("onComplete sees the error status (routes to subagents:failed in the host)", async () => {
    let completed: AgentRecord | undefined;
    manager = new AgentManager((r) => { completed = r; });
    failedRun("boom");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    await manager.getRecord(id)!.promise;

    expect(completed?.status).toBe("error");
  });

  it("an external stop still wins over a late failure resolution", async () => {
    manager = new AgentManager();
    let resolveRun: ((v: unknown) => void) | undefined;
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await Promise.resolve();
    manager.abort(id);
    resolveRun!({ responseText: "", session, aborted: false, steered: false, failure: "late error" });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
  });

  it("resume(): a failed final turn on the resumed prompt maps to error too", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    // resumeAgent bounds its fallback to this invocation, so a failed empty
    // resume yields text "" — never the prior turn's answer (#144 root-fix).
    vi.mocked(resumeMock).mockResolvedValue({
      text: "",
      failure: "retries exhausted on resume",
    });

    await manager.resume(id, "more")?.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted on resume");
    expect(record.result).toBe(""); // no stale prior answer
  });

  it("resume(): partial text produced before the failure is kept as result", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "new partial progress",
      failure: "provider died mid-turn",
    });

    await manager.resume(id, "more")?.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("new partial progress"); // salvageable, this-run text
  });
});

describe("AgentManager — pool slot accounting on settle", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  /** A run that only settles when its returned resolver is called. */
  function controllableRuns() {
    const resolvers = new Map<string, (v: any) => void>();
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        resolvers.set(prompt as string, () => resolve({
          responseText: "done",
          session: mockSession(),
          aborted: false,
          steered: false,
        }));
      }),
    );
    return resolvers;
  }

  it("a background agent settling frees its slot", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
    });
    const siblingId = manager.spawn(mockPi, mockCtx, "general-purpose", "sibling", {
      description: "sibling",
    });
    expect(manager.getRecord(siblingId)?.status).toBe("queued");

    await Promise.resolve();
    resolvers.get("parent")!(undefined);
    await manager.getRecord(parentId)?.promise;

    expect(manager.getRecord(siblingId)?.status).toBe("running");
  });
});

describe("AgentManager — drainQueue failure handling", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("a spawn that throws at drain time errors that record and keeps draining", async () => {
    // Strict worktree isolation is the documented drain-time failure: the check
    // runs in startAgent, which drainQueue calls minutes after spawn() returned.
    // If the throw escaped drainQueue, every agent still queued behind it would
    // be stranded forever — a hang, not an error.
    const { createWorktree } = await import("../src/worktree.js");
    const completed: AgentRecord[] = [];
    manager = new AgentManager(r => { completed.push(r); }, 1);

    let blocker: ((v: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        if (prompt === "first") blocker = () => resolve({
          responseText: "ok", session: mockSession(), aborted: false, steered: false,
        });
      }),
    );
    vi.mocked(createWorktree).mockResolvedValueOnce(undefined); // "not a git repo"

    const firstId = manager.spawn(mockPi, mockCtx, "X", "first", { description: "first" });
    const boomId = manager.spawn(mockPi, mockCtx, "X", "boom", {
      description: "boom", isolation: "worktree",
    });
    const lastId = manager.spawn(mockPi, mockCtx, "X", "last", { description: "last" });
    expect(manager.getRecord(boomId)?.status).toBe("queued");

    await Promise.resolve();
    blocker!(undefined);
    await manager.getRecord(firstId)?.promise;
    await manager.getRecord(boomId)?.promise;

    const boom = manager.getRecord(boomId)!;
    expect(boom.status).toBe("error");
    expect(boom.error).toContain('isolation: "worktree"');
    expect(boom.completedAt).toBeGreaterThan(0);
    expect(completed.map(r => r.id)).toEqual([firstId, boomId]);
    // ...and the drain continued past the failure rather than stopping there.
    expect(manager.getRecord(lastId)?.status).toBe("running");
  });

  it("a cwd deleted between enqueue and drain is caught by the re-validation", async () => {
    // spawn() validated this cwd when it was still there. startAgent checks
    // again precisely because a queued agent can start minutes later (TOCTOU) —
    // that second check has never run in a test.
    manager = new AgentManager(undefined, 1);

    let blocker: ((v: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        if (prompt === "first") blocker = () => resolve({
          responseText: "ok", session: mockSession(), aborted: false, steered: false,
        });
      }),
    );

    manager.spawn(mockPi, mockCtx, "X", "first", { description: "first" });
    const goneDir = mkdtempSync(join(tmpdir(), "pi-mgr-gone-"));
    const goneId = manager.spawn(mockPi, mockCtx, "X", "gone", {
      description: "gone", cwd: goneDir,
    });
    expect(manager.getRecord(goneId)?.status).toBe("queued");

    rmSync(goneDir, { recursive: true, force: true }); // vanishes while queued

    await Promise.resolve();
    blocker!(undefined);
    await manager.waitForAll();

    const gone = manager.getRecord(goneId)!;
    expect(gone.status).toBe("error");
    expect(gone.error).toContain(goneDir); // the curated message, not a raw ENOENT
  });

  it("raising maxConcurrent releases queued agents immediately", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);

    manager.spawn(mockPi, mockCtx, "X", "a", { description: "a" });
    const bId = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b" });
    expect(manager.getRecord(bId)?.status).toBe("queued");

    manager.setMaxConcurrent(2);
    expect(manager.getRecord(bId)?.status).toBe("running");
  });

  it("setMaxConcurrent clamps to at least 1", () => {
    manager = new AgentManager(undefined, 4);
    manager.setMaxConcurrent(0);
    expect(manager.getMaxConcurrent()).toBe(1);
  });
});

describe("AgentManager — pendingSteers flush", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("delivers steers queued before the session existed, in order, then clears them", async () => {
    // A steer sent in the window between spawn and session creation is parked on
    // the record. If the flush breaks, the user's course correction is silently
    // dropped — steer_subagent already told them it was queued.
    const steer = vi.fn().mockResolvedValue(undefined);
    let release: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        release = () => {
          opts.onSessionCreated?.({ steer, dispose: vi.fn() });
          resolve({ responseText: "ok", session: mockSession(), aborted: false, steered: false });
        };
      }),
    );

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "p" });
    const record = manager.getRecord(id)!;

    manager.steer(id, "first correction");
    manager.steer(id, "second correction");
    expect(record.pendingSteers).toEqual(["first correction", "second correction"]);

    await Promise.resolve();
    release!();
    await record.promise;

    expect(steer.mock.calls.map(c => c[0])).toEqual(["first correction", "second correction"]);
    // Cleared, or every later session creation would re-deliver the same steers.
    expect(record.pendingSteers).toBeUndefined();
  });

  // The viewers and RPC both steer through the manager and neither
  // of them emits the lifecycle event itself — this callback is the one place
  // `subagents:steered` comes from for every path except the tool.
  it("fires onSteered for a queued and a delivered steer, never for a refused one", async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    let createSession: (() => void) | undefined;
    let finish: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        createSession = () => opts.onSessionCreated?.({ steer, dispose: vi.fn() });
        finish = () => resolve({ responseText: "ok", session: mockSession(), aborted: false, steered: false });
      }),
    );

    const onSteered = vi.fn();
    manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, onSteered);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "p" });
    const record = manager.getRecord(id)!;

    expect(manager.steer(id, "before session")).toBe(true);
    expect(onSteered).toHaveBeenLastCalledWith(record, "before session");

    await Promise.resolve();
    createSession!();
    expect(manager.steer(id, "live")).toBe(true);
    expect(steer).toHaveBeenLastCalledWith("live");
    expect(onSteered).toHaveBeenLastCalledWith(record, "live");
    expect(onSteered).toHaveBeenCalledTimes(2);

    finish!();
    await record.promise;
    expect(manager.steer(id, "too late")).toBe(false);
    expect(onSteered).toHaveBeenCalledTimes(2);
  });

  it("a steer that rejects does not fail the run", async () => {
    const steer = vi.fn().mockRejectedValue(new Error("session closed"));
    let release: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        release = () => {
          opts.onSessionCreated?.({ steer, dispose: vi.fn() });
          resolve({ responseText: "ok", session: mockSession(), aborted: false, steered: false });
        };
      }),
    );

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "p" });
    const record = manager.getRecord(id)!;
    manager.steer(id, "hello");

    await Promise.resolve();
    release!();
    await expect(record.promise).resolves.toBe("ok");
    expect(record.status).toBe("completed");
  });
});

// waitForAll() had zero coverage despite backing the Symbol.for registry entry
// and the print-mode host's shutdown hold. Its loop exists BECAUSE drainQueue
// respects maxConcurrent: a single Promise.allSettled pass would return while
// queued agents had not even started. That reads like a redundant loop, which
// is exactly why it needs a test — collapsing it resolves early and silently.
describe("AgentManager — waitForAll", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("waits for agents that were still QUEUED when it was called", async () => {
    const resolvers = new Map<string, () => void>();
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
      new Promise<any>(resolve => {
        resolvers.set(prompt as string, () => resolve({
          responseText: "done", session: mockSession(), aborted: false, steered: false,
        }));
      }),
    );

    manager = new AgentManager(undefined, 1);
    const ids = ["a", "b", "c"].map(p =>
      manager.spawn(mockPi, mockCtx, "X", p, { description: p }),
    );
    // Only the first can be running; the other two are behind the pool.
    expect(manager.getRecord(ids[1])?.status).toBe("queued");

    let settled = false;
    const all = manager.waitForAll().then(() => { settled = true; });

    // Release ONLY the running one. A queued record has no `.promise` yet — it
    // is created when the queue starts it — so a single `Promise.allSettled`
    // pass sees just this one agent and would resolve here, with two agents
    // still unstarted. The retry loop is what makes that not happen, and
    // asserting after releasing everything would hide the difference entirely.
    await new Promise(r => setImmediate(r));
    resolvers.get("a")!();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(settled, "waitForAll resolved while agents were still queued").toBe(false);

    for (const p of ["b", "c"]) {
      resolvers.get(p)!();
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
    }
    await all;

    expect(settled).toBe(true);
    for (const id of ids) {
      expect(manager.getRecord(id)?.status, id).toBe("completed");
    }
  });

  it("resolves immediately when nothing is pending", async () => {
    manager = new AgentManager();
    await expect(manager.waitForAll()).resolves.toBeUndefined();
  });

  it("waits for an agent whose worktree is still being created", async () => {
    // Host drain must include worktree startup, not just child execution.
    const { createWorktree } = await import("../src/worktree.js");
    let releaseCopy!: () => void;
    vi.mocked(createWorktree).mockImplementationOnce(
      () => new Promise(resolve => {
        releaseCopy = () => resolve({ path: "/wt/copy", branch: "b", baseSha: "abc", workPath: "/wt/copy" });
      }),
    );
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    manager.spawn(mockPi, mockCtx, "X", "copying", {
      description: "copying", isolation: "worktree",
    });

    let settled = false;
    const all = manager.waitForAll().then(() => { settled = true; });
    await new Promise(r => setImmediate(r));
    expect(settled, "waitForAll resolved while the worktree was still being created").toBe(false);
    expect(runAgent).not.toHaveBeenCalled();

    await Promise.resolve();
    releaseCopy();
    await all;
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not reject when an agent fails", async () => {
    // allSettled, not all — one failing agent must not leave the caller hanging
    // on a rejection it never asked for.
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "p" });

    await expect(manager.waitForAll()).resolves.toBeUndefined();
    expect(manager.getRecord(id)?.status).toBe("error");
  });

  it("waits for a resume without spinning on the settled spawn promise", async () => {
    // An inline resume marks the record "running" but leaves `record.promise`
    // pointing at the spawn's, long settled. Awaiting that resolves in a
    // microtask, so the loop never yields: the resume's own I/O cannot run, the
    // record never leaves "running", and the process pins a core forever.
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first", session: mockSession(), aborted: false, steered: false,
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test" });
    await manager.getRecord(id)!.promise;

    // Settles on a timer: unreachable while the event loop is starved.
    vi.mocked(resumeAgent).mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve({ text: "second", aborted: false, steered: false }), 5)),
    );
    const resumed = manager.resume(id, "more");
    expect(manager.getRecord(id)?.status).toBe("running");

    // A spinning loop would hang the test past vitest's own timeout (which a
    // starved event loop cannot fire), so bound the passes and fail loudly.
    let passes = 0;
    const drain = vi.spyOn(manager as unknown as { drainQueue: () => void }, "drainQueue");
    drain.mockImplementation(() => {
      if (++passes > 1000) throw new Error("waitForAll spun without yielding");
    });

    await manager.waitForAll();
    expect(manager.getRecord(id)?.status).toBe("completed");
    await resumed?.promise;
    expect(passes).toBeLessThan(10);
  });

  it("a resume's record.promise is the in-flight run, settling only once the record is terminal", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first", session: mockSession(), aborted: false, steered: false,
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test" });
    const record = manager.getRecord(id)!;
    const spawnPromise = record.promise;
    await spawnPromise;

    let finish!: () => void;
    vi.mocked(resumeAgent).mockImplementation(() =>
      new Promise(resolve => { finish = () => resolve({ text: "second", aborted: false, steered: false }); }),
    );
    const resumed = manager.resume(id, "more");
    const waiting = record.promise;
    expect(waiting).not.toBe(spawnPromise);

    let woke = false;
    const waiter = waiting!.then(() => { woke = true; expect(record.status).toBe("completed"); });
    await new Promise(r => setImmediate(r));
    expect(woke, "the wait returned while the resume was still running").toBe(false);

    finish();
    await waiter;
    expect(record.result).toBe("second");
    await resumed?.promise;
  });
});

describe("AgentManager — dispose prunes worktree repos", () => {
  it("prunes the process cwd and every repo a worktree was created from", async () => {
    // Pruning needs pi (the git call is async now), so it is handed in at
    // dispose. A manager disposed without one just skips it.
    const { createWorktree, pruneWorktrees } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockResolvedValueOnce({
      path: "/wt/copy", branch: "b", baseSha: "abc", workPath: "/wt/copy",
    });
    vi.mocked(pruneWorktrees).mockClear().mockResolvedValue(undefined);
    resolvedRun();

    const manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "p", cwd: "/", isolation: "worktree",
    });
    await manager.getRecord(id)?.promise;
    await manager.getRecord(id)!.promise;

    manager.dispose();
    expect(pruneWorktrees).not.toHaveBeenCalled();

    manager.dispose(mockPi);
    expect(pruneWorktrees).toHaveBeenCalledWith(mockPi, process.cwd());
    // The caller-supplied cwd's repo too — that is where its worktree lived.
    expect(pruneWorktrees).toHaveBeenCalledWith(mockPi, "/");
  });
});

describe("AgentManager — background resume", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  // Spawn a background agent and let it settle so it holds a session to resume.
  async function spawnSettled(mgr: AgentManager): Promise<string> {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    const id = mgr.spawn(mockPi, mockCtx, "general-purpose", "task", {
      description: "task",
    });
    await mgr.getRecord(id)!.promise;
    return id;
  }

  it("returns immediately with a running record + promise, then settles and fires onComplete", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = await spawnSettled(manager);
    onComplete.mockClear(); // drop the spawn's own completion

    // Deferred resumeAgent so we can observe the mid-flight state.
    let finish!: (v: { text: string; failure?: string }) => void;
    vi.mocked(resumeAgent).mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );

    const record = await manager.resume(id, "keep going");
    // Returned immediately: still running, with a tracked promise, no notify yet.
    expect(record?.status).toBe("running");
    expect(record?.promise).toBeDefined();
    expect(onComplete).not.toHaveBeenCalled();

    finish({ text: "second" });
    await record!.promise;

    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.result).toBe("second");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a failed final turn on a background resume maps to error and still notifies", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = await spawnSettled(manager);
    onComplete.mockClear();

    vi.mocked(resumeAgent).mockResolvedValue({
      text: "partial",
      failure: "provider exploded",
    } as any);

    const record = await manager.resume(id, "again");
    await record!.promise;

    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.error).toBe("provider exploded");
    expect(manager.getRecord(id)!.result).toBe("partial"); // #144: keep this-run text
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("forwards activity/usage callbacks to the resumed run", async () => {
    manager = new AgentManager();
    const id = await spawnSettled(manager);

    const onToolActivity = vi.fn();
    const onAssistantUsage = vi.fn();
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onToolActivity?.({ type: "end", toolName: "grep" });
      opts.onAssistantUsage?.({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
      return { text: "ok" };
    });

    const record = await manager.resume(id, "go", undefined, {
      onToolActivity,
      onAssistantUsage,
    });
    await record!.promise;

    expect(onToolActivity).toHaveBeenCalledWith({ type: "end", toolName: "grep" });
    expect(onAssistantUsage).toHaveBeenCalledWith({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
    // Internal record bookkeeping still runs alongside the forwarded callbacks.
    expect(manager.getRecord(id)!.toolUses).toBe(1);
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
    expect(manager.getRecord(id)!.ownUsage).toEqual({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
  });

  it("updates the record before forwarding a resume’s activity and usage hooks", async () => {
    manager = new AgentManager();
    const id = await spawnSettled(manager);
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onToolActivity?.({ type: "end", toolName: "grep" });
      opts.onAssistantUsage?.({ input: 5, output: 3, cacheWrite: 0, cost: 0 });
      return { text: "ok" };
    });
    const seen: { toolUses: number; output: number }[] = [];
    const read = () => {
      const record = manager.getRecord(id)!;
      seen.push({ toolUses: record.toolUses, output: record.lifetimeUsage.output });
    };

    const record = await manager.resume(id, "go", undefined, { onToolActivity: read, onAssistantUsage: read });
    await record?.promise;

    expect(seen).toEqual([{ toolUses: 1, output: 0 }, { toolUses: 1, output: 3 }]);
  });

  it("queues a background resume when the concurrency pool is full", async () => {
    manager = new AgentManager(undefined, 1); // maxConcurrent = 1
    const id = await spawnSettled(manager);

    // Occupy the single slot with a never-settling background spawn.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const blockerId = manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
    });
    expect(manager.getRecord(blockerId)!.status).toBe("running");

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    vi.mocked(resumeAgent).mockClear(); // drop call history from earlier tests
    const record = await manager.resume(id, "later");

    expect(record?.status).toBe("queued");
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  // A detached resume returns while the record is still "running", so nothing
  // stops a second resume of the same agent. Starting one would replace
  // record.abortController — leaving the live run unreachable from /agents stop
  // and abortAll() — and then reject from session.prompt(), whose settle path
  // would report a failure and abort the children of a run still in progress.
  it("refuses to background-resume an agent whose run is still in flight", async () => {
    const onComplete = vi.fn();
    manager = new AgentManager(onComplete);
    const id = await spawnSettled(manager);
    onComplete.mockClear();

    vi.mocked(resumeAgent).mockClear();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));

    const first = await manager.resume(id, "go");
    expect(first?.status).toBe("running");
    const liveController = manager.getRecord(id)!.abortController;

    const second = await manager.resume(id, "go again");

    expect(second).toBeUndefined();
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    // The in-flight run is untouched: same controller, still running, no
    // spurious completion notification.
    expect(manager.getRecord(id)!.abortController).toBe(liveController);
    expect(manager.getRecord(id)!.status).toBe("running");
    expect(onComplete).not.toHaveBeenCalled();
    // Still stoppable — the point of keeping the original controller.
    expect(manager.abort(id)).toBe(true);
    expect(liveController!.signal.aborted).toBe(true);
  });

  it("refuses to background-resume an agent that is still queued", async () => {
    manager = new AgentManager(undefined, 1); // maxConcurrent = 1
    const id = await spawnSettled(manager);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
    });

    vi.mocked(resumeAgent).mockClear();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    expect((await manager.resume(id, "later"))?.status).toBe("queued");

    expect(await manager.resume(id, "later again")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  // onStarted is where the Agent tool hangs output-file streaming. It must fire
  // when the run actually begins — not when resume() returns — or a resume that
  // is stopped while queued would leave a live session subscription behind.
  it("fires onStarted when the run starts, not when a queued resume is registered", async () => {
    manager = new AgentManager(undefined, 1); // maxConcurrent = 1
    const id = await spawnSettled(manager);

    // Occupy the only slot with a run we can release on demand.
    let releaseBlocker!: (v: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => { releaseBlocker = resolve; }));
    const blockerId = manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
    });

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    const onStarted = vi.fn();
    const record = await manager.resume(id, "later", undefined, { onStarted });

    expect(record?.status).toBe("queued");
    expect(onStarted).not.toHaveBeenCalled();

    releaseBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(blockerId)?.promise;
    await Promise.resolve();

    expect(manager.getRecord(id)!.status).toBe("running");
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("never fires onStarted for a queued resume that is stopped before it drains", async () => {
    manager = new AgentManager(undefined, 1); // maxConcurrent = 1
    const id = await spawnSettled(manager);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "general-purpose", "blocker", {
      description: "blocker",
    });

    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));
    const onStarted = vi.fn();
    await manager.resume(id, "later", undefined, { onStarted })?.promise;

    expect(manager.abort(id)).toBe(true);
    expect(manager.getRecord(id)!.status).toBe("stopped");
    expect(onStarted).not.toHaveBeenCalled();
  });
});

// A `name` on the spawn adds a second handle rather than replacing the
// type-derived one. Tool lookups by either name reach the same agent.
describe("AgentManager — names as additive aliases", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  const spawnNamed = (m: AgentManager, type: string, name?: string) =>
    m.spawn(mockPi, mockCtx, type, "go", {
      description: "go",
      ...(name !== undefined && { name }),
    });

  it("assigns the type handle as well as the alias", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "auth-audit"))!;

    expect(record.handle).toBe("explore");
    expect(record.alias).toBe("auth-audit");
  });

  it("reaches the same agent by either name", () => {
    resolvedRun();
    manager = new AgentManager();
    const id = spawnNamed(manager, "Explore", "auth-audit");

    expect(manager.resolveMention("auth-audit")).toMatchObject({ kind: "live", record: { id } });
    expect(manager.resolveMention("explore")).toMatchObject({ kind: "live", record: { id } });
  });

  it("slugs a name that isn't typeable rather than rejecting the spawn", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "Auth Audit!"))!;

    expect(record.alias).toBe("auth-audit");
  });

  it("numbers an alias that collides with its own type handle", () => {
    // `name: "explore"` on an Explore would otherwise produce two identical
    // names on one record, and later a second agent could take one of them.
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "explore"))!;

    expect(record.handle).toBe("explore");
    expect(record.alias).toBe("explore-2");
  });

  it("stops a later type handle from colliding with an existing alias", () => {
    resolvedRun();
    manager = new AgentManager();
    spawnNamed(manager, "Plan", "explore"); // alias squats the Explore name
    const second = manager.getRecord(spawnNamed(manager, "Explore"))!;

    expect(second.handle).toBe("explore-2");
  });

  it("refuses to alias an agent to the reserved main handle", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore", "main"))!;

    expect(record.alias).toBe("main-2");
  });

  it("gives an unnamed agent no alias at all", () => {
    resolvedRun();
    manager = new AgentManager();
    const record = manager.getRecord(spawnNamed(manager, "Explore"))!;

    expect(record.alias).toBeUndefined();
    expect(record.handle).toBe("explore");
  });

  it("captures the session file so the agent can be resumed after eviction", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({
        dispose: vi.fn(),
        sessionManager: { getSessionFile: () => "/sessions/explore.jsonl" },
      });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false } as any;
    });
    manager = new AgentManager();
    const id = spawnNamed(manager, "Explore");
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.sessionFile).toBe("/sessions/explore.jsonl");
  });

  it("records no session file for an in-memory session", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({ dispose: vi.fn(), sessionManager: { getSessionFile: () => undefined } });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false } as any;
    });
    manager = new AgentManager();
    const id = spawnNamed(manager, "Explore");
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.sessionFile).toBeUndefined();
  });
});

describe("AgentManager — effective model and thinking write-back", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose?.();
    vi.restoreAllMocks();
  });

  /** Run a spawn whose session reports the given runtime model/level. */
  async function spawnWithSession(
    invocation: AgentRecord["invocation"],
    runtime: { model?: { provider: string; id: string; name?: string }; thinkingLevel?: string },
  ): Promise<AgentRecord> {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({ dispose: vi.fn(), ...runtime });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false } as any;
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "go",
      invocation,
    });
    await manager.getRecord(id)!.promise;
    return manager.getRecord(id)!;
  }

  it("relabels the record with the model the session actually runs", async () => {
    const record = await spawnWithSession(
      { modelName: "pre-session", modelId: "pre/session", thinking: "high" },
      { model: { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }, thinkingLevel: "high" },
    );

    expect(record.invocation).toMatchObject({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
    });
  });

  it("keeps the requested level when pi clamps it to what the model supports", async () => {
    const record = await spawnWithSession(
      { thinking: "max" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" },
    );

    expect(record.invocation!.thinking).toBe("high");
    expect(record.invocation!.requestedThinking).toBe("max");
  });

  it("records no request when the level was honored", async () => {
    const record = await spawnWithSession(
      { thinking: "high" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" },
    );

    expect(record.invocation!.requestedThinking).toBeUndefined();
  });

  it("does not overwrite a request the agent file already overrode", async () => {
    // Frontmatter pinned `low` over a caller's `max`, then the model clamped it
    // again. The caller asked for `max` — that is what the surfaces must say,
    // not the intermediate value frontmatter chose.
    const record = await spawnWithSession(
      { thinking: "low", requestedThinking: "max" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "minimal" },
    );

    expect(record.invocation!.thinking).toBe("minimal");
    expect(record.invocation!.requestedThinking).toBe("max");
  });

  it("gives a spawn that carried no invocation one to display", async () => {
    // A cross-extension RPC spawn can omit invocation metadata.
    const record = await spawnWithSession(
      undefined,
      { model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "xhigh" },
    );

    expect(record.invocation).toEqual({
      modelName: "gpt-5.6-sol",
      modelId: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
    });
  });

  it("keeps the requested level when the session reports no level of its own", async () => {
    // An older pi or a stubbed session degrades to "nothing to say about the
    // level", which must not read as "no level" on every surface.
    const record = await spawnWithSession(
      { thinking: "max" },
      { model: { provider: "anthropic", id: "claude-haiku-4-5" } },
    );

    expect(record.invocation!.thinking).toBe("max");
    expect(record.invocation!.requestedThinking).toBeUndefined();
    expect(record.invocation!.modelName).toBe("claude-haiku-4-5");
  });

  it("leaves the invocation alone when the session reports no model", async () => {
    const record = await spawnWithSession({ thinking: "max" }, {});

    expect(record.invocation).toEqual({ thinking: "max" });
  });
});

// Frontmatter is authoritative (README "Frontmatter is authoritative"): the
// agent file's `isolation:` must hold on every spawn path. Only the Agent tool
// resolves it before calling the manager; RPC spawns forward only their caller's value.
describe("AgentManager — the agent file's `isolation` wins over the spawn option", () => {
  let manager: AgentManager;
  const wt = { path: "/wt/a", branch: "pi-agent-a", baseSha: "abc", workPath: "/wt/a" };

  function spawnAs(
    fileIsolation: "worktree" | "off" | undefined,
    optionIsolation: "worktree" | undefined,
    { type = "walled" }: { type?: string } = {},
  ) {
    registerAgents(new Map([["walled", { name: "walled", isolation: fileIsolation } as any]]));
    vi.mocked(createWorktree).mockReset();
    vi.mocked(createWorktree).mockResolvedValue(wt as never);
    resolvedRun();
    manager = new AgentManager();
    return manager.spawn(mockPi, mockCtx, type, "go", {
      description: "go",
      ...(optionIsolation !== undefined ? { isolation: optionIsolation } : {}),
    });
  }

  afterEach(() => {
    manager?.dispose();
    registerAgents(new Map());
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(true);
  });

  it("isolation: worktree in the file applies when the spawn omits it, and tags the record", async () => {
    const id = spawnAs("worktree", undefined);
    await manager.getRecord(id)?.promise;

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)!.worktree).toEqual(wt);
    // The widget's "worktree" tag reads the invocation snapshot, which only
    // the Agent tool used to seed.
    expect(manager.getRecord(id)!.invocation?.isolation).toBe("worktree");
  });

  it("isolation: off in the file refuses a spawn's isolation: worktree", async () => {
    const id = spawnAs("off", "worktree");
    await manager.getRecord(id)?.promise;

    expect(createWorktree).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.worktree).toBeUndefined();
  });

  it("the spawn option decides when the file leaves isolation unset", async () => {
    const id = spawnAs(undefined, "worktree");
    await manager.getRecord(id)?.promise;

    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it("the project switch still refuses a file's isolation: worktree", async () => {
    vi.mocked(isWorktreeIsolationEnabled).mockReturnValue(false);
    const id = spawnAs("worktree", undefined);
    await manager.getRecord(id)?.promise;

    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("an unregistered type keeps the spawn option", async () => {
    const id = spawnAs("off", "worktree", { type: "not-registered" });
    await manager.getRecord(id)?.promise;

    expect(createWorktree).toHaveBeenCalledTimes(1);
  });
});

describe("AgentManager — waitForSettled (#443)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  /** A tool call that ignores abort and finishes only when its gate opens. */
  function stubbornAgent() {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const writes: string[] = [];
    vi.mocked(runAgent).mockImplementation(async () => {
      await gate;
      writes.push("OLD");
      return { responseText: "done", session: mockSession(), aborted: true, steered: false };
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "go" });
    return { id, writes, openGate };
  }

  it("does not resolve while the aborted agent is still in a tool call", async () => {
    const { id, writes, openGate } = stubbornAgent();
    await Promise.resolve();
    manager.abort(id);
    expect(manager.getRecord(id)!.status).toBe("stopped");

    let settled: boolean | undefined;
    const waiting = manager.waitForSettled(id, 5_000).then((s) => { settled = s; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBeUndefined();

    openGate();
    await waiting;
    expect(settled).toBe(true);
    writes.push("NEW");
    expect(writes).toEqual(["OLD", "NEW"]);
  });

  it("reports false at the bound when the agent has not settled", async () => {
    const { id, openGate } = stubbornAgent();
    await Promise.resolve();
    manager.abort(id);
    expect(await manager.waitForSettled(id, 0)).toBe(false);
    openGate();
    await manager.getRecord(id)!.promise;
  });

  it("resolves true at once for an agent that has already settled", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "solo", { description: "solo" });
    await manager.getRecord(id)!.promise;

    expect(await manager.waitForSettled(id, 1_000)).toBe(true);
  });

  it("reports a stopped agent as settling until its run ends", async () => {
    const { id, openGate } = stubbornAgent();
    await Promise.resolve();
    manager.abort(id);
    expect(manager.getRecord(id)!.status).toBe("stopped");
    expect(manager.isSettling(id)).toBe(true);

    openGate();
    await manager.getRecord(id)!.promise;
    expect(manager.isSettling(id)).toBe(false);
  });

  it("tracks an aborted resume until its own work settles", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "go" });
    await manager.getRecord(id)!.promise;
    let finish!: () => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ text: "done", aborted: true, steered: false });
    }));

    const resumed = manager.resume(id, "more");
    await Promise.resolve();
    manager.abort(id);
    try {
      expect(manager.isSettling(id)).toBe(true);
      expect(await manager.waitForSettled(id, 0)).toBe(false);
    } finally {
      finish();
      await resumed?.promise;
    }
    expect(await manager.waitForSettled(id, 0)).toBe(true);
  });
});
