/**
 * status-note-wiring.test.ts — proves the status note actually reaches the
 * PARENT through the real tool handlers, not just that getStatusNote() returns
 * a string. Drives the registered `Agent` / `get_subagent_result` tools and
 * inspects the text delivered back, for a turn-limit abort and a user stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Hermetic, hermeticDir, publishedManager, testAgentFile } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, eventHandlers, lifecycle };
}

// The RPC channels are registered on the first bound session_start (#142), so a
// test that drives them must fire it first — as a real session always does. A
// sessionId-less ctx makes startScheduler short-circuit (no filesystem touch).
async function bind(lifecycle: Map<string, any>) {
  const bindCtx = ctx();
  bindCtx.sessionManager.getSessionId = vi.fn(() => undefined);
  await lifecycle.get("session_start")({}, bindCtx);
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

let project: Hermetic;
beforeEach(() => {
  project = hermeticDir({ agentFiles: { worker: testAgentFile("worker") } });
});
afterEach(() => project.restore());

describe("status note reaches the parent through the real handlers", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it("turn-limit abort → reading the result flags an incomplete outcome", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial work so far",
      session: { dispose: vi.fn() } as any,
      aborted: true, // hard turn-limit abort
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const res = await tools.get("Agent").execute(
      "tc1",
      { prompt: "go", description: "d", subagent_type: "worker" },
      undefined, undefined, ctx(),
    );

    await publishedManager().waitForAll();
    const read = await tools.get("get_subagent_result").execute("read", { agent_id: res.details.agentId }, undefined, undefined, ctx());
    const out = textOf(read);
    // Exact lead clause, not just "turn limit": a steered/aborted mix-up would
    // otherwise slip through, and they are different outcomes.
    expect(out).toContain("aborted — hit the turn limit");
    expect(out).toContain("partial work so far");     // partial result still delivered
    expect(out).not.toContain("STOPPED BY THE USER"); // not mislabelled as a user stop

    expect(out).toContain("output may be incomplete");
  });

  it("background user-stop → get_subagent_result flags STOPPED BY THE USER (not completed)", async () => {
    const finish = Promise.withResolvers<any>();
    vi.mocked(runAgent).mockReturnValue(finish.promise);
    const { pi, tools, eventHandlers, lifecycle } = makePi();
    subagentsExtension(pi);
    await bind(lifecycle); // register RPC channels via session_start (#142)

    const spawn = await tools.get("Agent").execute(
      "tc2",
      { prompt: "go", description: "d", subagent_type: "worker" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "background spawn should surface an agent id").toBeTruthy();

    // The user stops it — same path the viewer's stop key uses (manager.abort).
    const stop = eventHandlers.get("subagents:rpc:stop")?.({ requestId: "r1", agentId: id });
    finish.resolve({ responseText: "partial work so far", session: { dispose: vi.fn() }, aborted: false, steered: false });
    await stop;

    const res = await tools.get("get_subagent_result").execute(
      "tc3", { agent_id: id }, undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("STOPPED BY THE USER");
    expect(out).toContain("the task was NOT finished");
    expect(out).not.toContain("Done"); // not surfaced as a normal completion

    expect(out).not.toContain("everything the agent produced is above");
  });
});

// `subagents:compacted` is a documented cross-extension contract (README:495)
// with an exact payload. Nothing inside this process reads it, so a dropped or
// renamed field is completely silent here and only breaks a consumer.
describe("subagents:compacted", () => {
  /** Run an agent and fire one compaction from inside runAgent's callbacks. */
  function runWithCompaction(info: { reason: string; tokensBefore: number }) {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      opts.onCompaction?.(info);
      return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
    });
  }

  it("emits the documented payload when a top-level agent's session compacts", async () => {
    runWithCompaction({ reason: "threshold", tokensBefore: 12345 });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tc-compact",
      { prompt: "go", description: "compacting agent", subagent_type: "worker" },
      undefined, undefined, ctx(),
    );

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:compacted", expect.objectContaining({
      id: expect.any(String),
      type: "worker",
      description: "compacting agent",
      reason: "threshold",
      tokensBefore: 12345,
      compactionCount: 1,
    }));
  });

  it("counts repeated compactions on the same agent", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 1 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 2 });
      return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tc-compact2",
      { prompt: "go", description: "twice", subagent_type: "worker" },
      undefined, undefined, ctx(),
    );

    const counts = pi.events.emit.mock.calls
      .filter((c: any[]) => c[0] === "subagents:compacted")
      .map((c: any[]) => c[1].compactionCount);
    expect(counts).toEqual([1, 2]);
  });

});
