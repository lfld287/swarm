import { afterEach, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, publishedManager, testAgentFile, textOf } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async (original) => ({
  ...(await original<typeof import("../src/agent-runner.js")>()),
  runAgent: vi.fn(),
}));

const done = { responseText: "Child answer", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
let project: Hermetic;
let host: ReturnType<typeof makePi>;
let manager: import("./helpers/boot-extension.js").TestManager;

function boot(settings: Record<string, unknown> = {}, agent = testAgentFile("worker")) {
  project = hermeticDir({ settings: { maxConcurrent: 1, outputTranscript: false, schedulingEnabled: false, ...settings }, agentFiles: { worker: agent } });
  host = makePi();
  subagentsExtension(host.pi);
  manager = publishedManager();
}

const call = (name: string, params: Record<string, unknown>) => host.tools.get(name).execute(name, params, undefined, undefined, ctx());
const spawn = (description: string, extras: Record<string, unknown> = {}) => call("Agent", { description, subagent_type: "worker", prompt: "Do work", ...extras });
const read = (id: string, extras: Record<string, unknown> = {}) => call("get_subagent_result", { agent_id: id, ...extras });

afterEach(async () => {
  await host?.lifecycle.get("session_shutdown")?.();
  vi.useRealTimers();
  project?.restore();
});

it("reads running and queued IDs without advancing time or consuming either notification", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  boot();
  const finish = Promise.withResolvers<typeof done>();
  vi.mocked(runAgent).mockReturnValue(finish.promise);
  const ids: string[] = [];
  try {
    for (const status of ["running", "queued"]) {
      const result = await spawn(status);
      expect(result.details).toMatchObject({ status, agentId: expect.any(String) });
      const id = result.details.agentId;
      ids.push(id);
      const readout = await Promise.race([read(id).then(textOf), flush().then(() => "Read blocked")]);
      expect(readout).toContain(`Status: ${status}`);
      expect(readout).not.toContain("No output.");
      expect(manager.getRecord(id)?.resultConsumed).toBeFalsy();
    }
    expect(host.pi.sendMessage).not.toHaveBeenCalled();
  } finally {
    finish.resolve(done);
    await manager.waitForAll();
  }
  await vi.advanceTimersByTimeAsync(NOTIFICATION_HOLD_MS);
  expect(host.pi.sendMessage).toHaveBeenCalledOnce();
  const [message, delivery] = host.pi.sendMessage.mock.calls[0];
  expect(message.customType).toBe("subagent-notification");
  expect(delivery).toEqual({ deliverAs: "steer", triggerTurn: true });
  for (const id of ids) {
    expect(message.content).toContain(id);
    expect(textOf(await read(id))).toContain("Child answer");
    expect(manager.getRecord(id)?.resultConsumed).toBe(true);
  }
});

it("omits wait from schema and rejects legacy explicit values without consuming", async () => {
  vi.useFakeTimers();
  boot();
  vi.mocked(runAgent).mockResolvedValue(done);
  const id = (await spawn("done")).details.agentId;
  await manager.waitForAll();
  expect(host.tools.get("get_subagent_result").parameters.properties).not.toHaveProperty("wait");
  for (const wait of [false, true, null]) {
    const result = await read(id, { wait });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Result reads never wait; omit wait and read after notification.");
    expect(manager.getRecord(id)?.resultConsumed).toBeFalsy();
  }
  await vi.advanceTimersByTimeAsync(NOTIFICATION_HOLD_MS);
  expect(host.pi.sendMessage).toHaveBeenCalledOnce();
});
