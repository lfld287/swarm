import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { getAvailableTypes } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, testAgentFile, textOf } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.restoreAllMocks();
});

afterEach(async () => {
  // The manager registry is a globalThis symbol claimed by the first activation
  // that finds it free and released only on shutdown. A test that throws before
  // its own shutdown would otherwise leave it pointing at a dead manager, and
  // the NEXT test's `managerRegistry()` would silently read that one instead.
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Enough of an AgentSession for the manager's and index's hooks. */
function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

/** A runAgent that never settles, so the agent stays "running". */
function heldRun(session: any) {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        opts.onSessionCreated?.(session);
      }) as any,
  );
}

/** A runAgent that finishes immediately, leaving a resumable record behind. */
function finishedRun(session: any) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session,
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
}

/** Boot the real extension. `outputTranscript: false` keeps the run off disk. */
function boot() {
  hermetic = hermeticDir({
    settings: { outputTranscript: false },
    agentFiles: { Surveyor: testAgentFile("Surveyor"), Plan: testAgentFile("Plan") },
  });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

async function spawnBackground(tools: Map<string, any>) {
  return tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "find flaky tests", subagent_type: "Surveyor" },
    undefined,
    undefined,
    ctx(),
  );
}

describe("handles as tool arguments", () => {
  it("steers by handle, not just by raw id", async () => {
    const { tools } = boot();
    const session = fakeSession();
    heldRun(session);
    await spawnBackground(tools);
    await flush();

    const r = await tools.get("steer_subagent").execute(
      "tc", { agent_id: "surveyor", message: "look at the RPC path" }, undefined, undefined, ctx(),
    );

    expect(session.steer).toHaveBeenCalledWith("look at the RPC path");
    expect(textOf(r)).not.toContain("Agent not found");
  });

  it("steers by the name the model gave the agent", async () => {
    const { tools } = boot();
    const session = fakeSession();
    heldRun(session);
    await tools.get("Agent").execute(
      "tc-named",
      { prompt: "go", description: "audit", subagent_type: "Surveyor", name: "auth-audit" },
      undefined, undefined, ctx(),
    );
    await flush();

    await tools.get("steer_subagent").execute(
      "tc", { agent_id: "auth-audit", message: "keep going" }, undefined, undefined, ctx(),
    );

    expect(session.steer).toHaveBeenCalledWith("keep going");
  });

  it("reads a result by handle", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    await spawnBackground(tools);
    await flush();

    const r = await tools.get("get_subagent_result").execute(
      "tc", { agent_id: "surveyor" }, undefined, undefined, ctx(),
    );

    expect(textOf(r)).toContain("first answer");
  });

  it("still reports an unknown reference as not found", async () => {
    const { tools } = boot();

    const r = await tools.get("steer_subagent").execute(
      "tc", { agent_id: "nosuchagent", message: "hi" }, undefined, undefined, ctx(),
    );

    expect(textOf(r)).toContain("Agent not found");
  });
});

it("leaves @Plan go as ordinary input without spawning an agent", async () => {
  const spawn = vi.spyOn(AgentManager.prototype, "spawn");
  const { lifecycle } = boot();
  const sessionCtx = ctx();
  const addAutocompleteProvider = vi.fn();
  sessionCtx.ui.addAutocompleteProvider = addAutocompleteProvider;
  await lifecycle.get("session_start")({ type: "session_start" }, sessionCtx);
  expect(getAvailableTypes()).toContain("Plan");

  const event = { type: "input", text: "@Plan go", source: "interactive" };
  const result = await lifecycle.get("input")?.(event, sessionCtx);
  await flush();

  expect(lifecycle.has("input")).toBe(false);
  expect(result).toBeUndefined();
  expect(spawn).not.toHaveBeenCalled();
  expect(addAutocompleteProvider).not.toHaveBeenCalled();
});
