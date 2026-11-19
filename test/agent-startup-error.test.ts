import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import subagentsExtension from "../src/index.js";
import { createWorktree } from "../src/worktree.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, publishedManager, testAgentFile, textOf } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async (original) => ({
  ...(await original<typeof import("../src/agent-runner.js")>()), runAgent: vi.fn(),
}));
vi.mock("../src/worktree.js", async (original) => ({
  ...(await original<typeof import("../src/worktree.js")>()), createWorktree: vi.fn(),
}));

const done = { responseText: "Normal answer", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
let project: Hermetic;
let host: ReturnType<typeof makePi>;

async function boot() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  project = hermeticDir({ settings: { maxConcurrent: 1, schedulingEnabled: false, outputTranscript: false }, agentFiles: { worker: testAgentFile("worker") } });
  host = makePi();
  subagentsExtension(host.pi);
  await host.lifecycle.get("session_start")({}, ctx());
  vi.mocked(runAgent).mockReset().mockResolvedValue(done);
  vi.mocked(createWorktree).mockReset().mockResolvedValue(undefined);
  return publishedManager();
}

afterEach(async () => {
  await host?.lifecycle.get("session_shutdown")?.();
  project?.restore();
  vi.useRealTimers();
});

const spawn = (description: string, isolation?: string) => host.tools.get("Agent").execute(description,
  { description, isolation, prompt: description, subagent_type: "worker" }, undefined, undefined, ctx());
const read = (id: string) => host.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, ctx());

async function rpc(method: string, params: Record<string, unknown>) {
  const channel = `subagents:rpc:${method}`;
  const handler = host.pi.events.on.mock.calls.find(([name]: any[]) => name === channel)[1];
  await handler({ requestId: method, ...params });
  return host.pi.events.emit.mock.calls.findLast(([name]: any[]) => name === `${channel}:reply:${method}`)[1];
}

describe("post-acceptance failures and cancellations", () => {
  it.each(["running", "queued"])("retains a failed worktree ID accepted as %s, reports once, and keeps draining", async (expected) => {
    const manager = await boot();
    const slot = Promise.withResolvers<typeof done>();
    if (expected === "queued") {
      vi.mocked(runAgent).mockImplementationOnce(() => slot.promise);
      await spawn("holder");
    }
    const copy = Promise.withResolvers<undefined>();
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    const { details } = await spawn("doomed", "worktree");
    expect(details).toMatchObject({ status: expected, agentId: expect.any(String) });
    const id = details.agentId;
    const after = (await spawn("after")).details.agentId;
    expect(manager.getRecord(after)?.status).toBe("queued");
    slot.resolve(done);
    copy.resolve(undefined);
    await manager.waitForAll();
    expect(manager.getRecord(id)).toMatchObject({ status: "error", error: expect.stringContaining('isolation: "worktree"') });
    expect(manager.getRecord(after)?.status).toBe("completed");
    expect(host.pi.events.emit.mock.calls.filter(([name, payload]: any[]) => name === "subagents:failed" && payload.id === id)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_HOLD_MS);
    const messages = host.pi.sendMessage.mock.calls.flatMap(([message]: any[]) => [message.details, ...(message.details.others ?? [])]);
    expect(messages.filter((detail: any) => detail.id === id)).toEqual([expect.objectContaining({ id, status: "error" })]);
    expect(textOf(await read(id))).toMatch(/Status: error[\s\S]*Cannot run with isolation/);
  });

  it("returns RPC IDs before worktree startup and ignores the retired mode option", async () => {
    const manager = await boot();
    const copy = Promise.withResolvers<undefined>();
    vi.mocked(createWorktree).mockReturnValueOnce(copy.promise);
    const pending = rpc("spawn", { type: "worker", prompt: "copy", options: { description: "copy", isolation: "worktree" } });
    try {
      const first = await Promise.race([pending, flush().then(() => undefined)]);
      expect(first).toMatchObject({ success: true, data: { id: expect.any(String), status: "running" } });
      const firstId = first.data.id;
      const queued = await rpc("spawn", { type: "worker", prompt: "queued", options: { description: "queued", isBackground: false } });
      expect(queued).toMatchObject({ success: true, data: { id: expect.any(String), status: "queued" } });
      expect(manager.getRecord(queued.data.id)?.status).toBe("queued");
      expect(runAgent).not.toHaveBeenCalled();
      copy.resolve(undefined);
      await manager.waitForAll();
      expect(manager.getRecord(firstId)?.status).toBe("error");
      expect(manager.getRecord(queued.data.id)?.status).toBe("completed");
    } finally {
      copy.resolve(undefined);
      await pending;
      await manager.waitForAll();
    }
  });

  it("rejects invalid RPC cwd before creating an ID or occupying a slot", async () => {
    await boot();
    expect(await rpc("spawn", { type: "worker", prompt: "bad", options: { description: "bad", cwd: "relative" } }))
      .toEqual({ success: false, error: expect.stringContaining("must be an absolute path") });
    expect(runAgent).not.toHaveBeenCalled();
    expect((await rpc("list", {})).data.agents).toEqual([]);
  });

  it("stops a queued ID once without running it or releasing the holder's slot", async () => {
    const manager = await boot();
    const slot = Promise.withResolvers<typeof done>();
    vi.mocked(runAgent).mockImplementationOnce(() => slot.promise);
    await spawn("holder");
    const id = (await spawn("cancel")).details.agentId;
    const after = (await spawn("after")).details.agentId;
    expect(await rpc("stop", { agentId: id })).toEqual({ success: true, data: { settled: true } });
    expect(await rpc("stop", { agentId: id })).toEqual({ success: false, error: "Agent is not running" });
    expect(manager.getRecord(after)?.status).toBe("queued");
    slot.resolve(done);
    await manager.waitForAll();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_HOLD_MS);
    expect(vi.mocked(runAgent).mock.calls.map(([, , prompt]) => prompt)).toEqual(["holder", "after"]);
    expect(host.pi.events.emit.mock.calls.filter(([name, payload]: any[]) => name === "subagents:failed" && payload.id === id)).toHaveLength(1);
    const messages = host.pi.sendMessage.mock.calls.flatMap(([message]: any[]) => [message.details, ...(message.details.others ?? [])]);
    expect(messages.filter((detail: any) => detail.id === id)).toEqual([expect.objectContaining({ id, status: "stopped" })]);
    expect(textOf(await read(id))).toContain("Status: stopped");
  });
});
