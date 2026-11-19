import { afterEach, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
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

afterEach(async () => {
  await host?.lifecycle.get("session_shutdown")?.();
  vi.useRealTimers();
  project?.restore();
});

it("accepts with a live ID while the child remains unresolved, ignoring retired settings and frontmatter", async () => {
  boot({ backgroundByDefault: false, maxConcurrentForeground: 1 }, testAgentFile("worker").replace("tools: read", "tools: read\nrun_in_background: false"));
  const finish = Promise.withResolvers<typeof done>();
  const child = vi.mocked(runAgent).mockReturnValue(finish.promise);
  const launch = spawn("detached");
  try {
    const result = await Promise.race([launch, flush().then(() => undefined)]);
    expect(result?.details).toMatchObject({ agentId: expect.any(String), status: "running" });
    expect(textOf(result)).toContain(`Agent ID: ${result.details.agentId}`);
    expect(manager.getRecord(result.details.agentId)?.status).toBe("running");
    expect(child).toHaveBeenCalledOnce();
  } finally {
    finish.resolve(done);
    await launch;
    await manager.waitForAll();
  }
});

it("omits the retired Agent option from schema and rejects it before acceptance", async () => {
  boot();
  vi.mocked(runAgent).mockClear();
  expect(host.tools.get("Agent").parameters.properties).not.toHaveProperty("run_in_background");
  for (const legacy of [false, true, null]) {
    const result = await spawn("legacy", { run_in_background: legacy });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Agent only runs in the background; omit run_in_background.");
    expect(result.details?.agentId).toBeUndefined();
  }
  expect(host.pi.events.emit).not.toHaveBeenCalledWith("subagents:created", expect.anything());
  expect(runAgent).not.toHaveBeenCalled();
});
