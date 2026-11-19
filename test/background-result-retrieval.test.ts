import { afterEach, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi, publishedManager, testAgentFile, textOf } from "./helpers/boot-extension.js";

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

it("puts the real ID in model-visible text, not just in renderer details", async () => {
  boot();
  vi.mocked(runAgent).mockResolvedValue({ ...done, steered: true });
  const receipt = await spawn("steered");
  const id = /Agent ID: (\S+)/.exec(textOf(receipt))?.[1];
  expect(id).toBeTruthy();
  expect(id).toBe(receipt.details.agentId);
  expect(textOf(receipt)).not.toContain("Child answer");
  await manager.waitForAll();
});

it("reads the notified wrap-up by real ID; an invented ID doesn't resolve", async () => {
  vi.useFakeTimers();
  boot();
  vi.mocked(runAgent).mockResolvedValue({ ...done, steered: true });
  const id = (await spawn("steered")).details.agentId;
  await manager.waitForAll();
  await vi.advanceTimersByTimeAsync(NOTIFICATION_HOLD_MS);
  expect(host.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(id) }), expect.anything());
  const result = textOf(await read(id));
  expect(result).toContain("wrapped up at the turn limit");
  expect(result).toContain("Child answer");
  expect(textOf(await read("made-up-agent-id"))).toContain("Agent not found");
});

it("keeps unread records on switch, evicts consumed ones on switch, and expires unread ones normally", async () => {
  vi.useFakeTimers();
  boot();
  vi.mocked(runAgent).mockResolvedValue(done);
  const id = (await spawn("eviction")).details.agentId;
  const idleId = (await spawn("expiry")).details.agentId;
  await manager.waitForAll();
  await host.lifecycle.get("session_before_switch")?.();
  expect(manager.getRecord(id)?.status).toBe("completed");
  expect(textOf(await read(id))).toContain("Child answer");
  await host.lifecycle.get("session_before_switch")?.();
  expect(manager.getRecord(id)).toBeUndefined();
  expect(manager.getRecord(idleId)?.status).toBe("completed");
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  expect(manager.getRecord(idleId)).toBeUndefined();
});
