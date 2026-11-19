import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agentRunner from "../../src/agent-runner.js";
import { NOTIFICATION_HOLD_MS } from "../../src/completion-outbox.js";
import subagentsExtension from "../../src/index.js";
import type { AgentRecord } from "../../src/types.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "../helpers/boot-extension.js";

vi.mock("../../src/agent-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof agentRunner>()),
  runAgent: vi.fn(),
}));

type ToolResult = { isError?: boolean; details?: { agentId?: string } };
type Manager = {
  getRecord(id: string): AgentRecord | undefined;
  waitForAll(): Promise<void>;
};

const agentId = (result: ToolResult) => result.details?.agentId ?? /Agent ID: (\S+)/.exec(textOf(result))?.[1];

function gate() {
  let open!: () => void;
  const blocked = new Promise<void>((resolve) => { open = resolve; });
  return { blocked, open };
}

describe("background-only dispatch contract", () => {
  let project: Hermetic;
  let host: ReturnType<typeof makePi>;
  let manager: Manager;
  const completedRun: agentRunner.RunResult = {
    responseText: "Child finished.",
    session: { dispose: vi.fn() } as unknown as AgentSession,
    aborted: false,
    steered: false,
  };

  beforeEach(() => {
    vi.mocked(agentRunner.runAgent).mockReset().mockResolvedValue(completedRun);
  });

  afterEach(async () => {
    try {
      await host?.lifecycle.get("session_shutdown")?.();
    } finally {
      vi.useRealTimers();
      project?.restore();
    }
  });

  function boot(agentFiles?: Record<string, string>) {
    project = hermeticDir({
      agentFiles,
      settings: { outputTranscript: false, maxConcurrent: 1, defaultJoinMode: "async" },
    });
    host = makePi();
    subagentsExtension(host.pi);
    const globals = globalThis as Record<symbol, Manager | undefined>;
    const published = globals[Symbol.for("pi-subagents:manager")];
    if (!published) throw new Error("Test setup: no subagent manager was published");
    manager = published;
  }

  function call(toolName: string, callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = host.tools.get(toolName);
    if (!tool) throw new Error(`Test setup: ${toolName} was not registered`);
    return tool.execute(callId, args, undefined, undefined, ctx({ cwd: project.dir }));
  }

  const worker = { worker: "---\ndescription: Contract worker\ntools: read\n---\nDo the work.\n" };
  const spawn = (callId: string, params: Record<string, unknown> = {}) => call("Agent", callId, {
    subagent_type: "worker",
    prompt: "Respond with a short summary.",
    description: callId,
    ...params,
  });

  it("rejects Agent dispatch from an empty registry and explains where to define a role", async () => {
    boot();
    const outcome = await spawn("empty-registry").then(
      (result) => ({ rejected: result.isError === true, message: textOf(result) }),
      (error: unknown) => ({ rejected: true, message: error instanceof Error ? error.message : String(error) }),
    );
    await manager.waitForAll();

    expect({ ...outcome, dispatched: vi.mocked(agentRunner.runAgent).mock.calls.length > 0 },
      "An empty registry must reject the call, not launch the built-in fallback",
    ).toEqual({
      rejected: true,
      dispatched: false,
      message: expect.stringMatching(/^(?=[\s\S]*\(none\))(?=[\s\S]*(?:\.pi|\.agents)\/agents\/<name>\.md)/i),
    });
  });

  it("returns an agent ID while worktree startup is still blocked", async () => {
    boot(worker);
    const worktreeAdd = gate();
    let attemptedWorktree = false;
    host.pi.exec.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        attemptedWorktree = true;
        await worktreeAdd.blocked;
      }
      return { stdout: args.includes("--show-toplevel") ? project.dir : "HEAD", stderr: "", code: 0, killed: false };
    });

    const launch = spawn("worktree-start", { isolation: "worktree" });
    let atReturn: string | { id?: string; status?: AgentRecord["status"] };
    try {
      atReturn = await Promise.race([
        launch.then((result) => {
          const id = agentId(result);
          return { id, status: id ? manager.getRecord(id)?.status : undefined };
        }),
        flush().then(() => "Agent call still pending"),
      ]);
    } finally {
      worktreeAdd.open();
      await launch;
      await manager.waitForAll();
    }

    expect({ atReturn, attemptedWorktree }, "Agent must return a live ID without awaiting worktree creation").toEqual({
      attemptedWorktree: true,
      atReturn: { id: expect.stringMatching(/\S+/), status: expect.stringMatching(/^(queued|running)$/) },
    });
  });

  it("reads a queued run without waiting or consuming its completion notification", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    boot(worker);
    const finish = gate();
    vi.mocked(agentRunner.runAgent).mockImplementation(async () => {
      await finish.blocked;
      return completedRun;
    });

    let id: string;
    let status: AgentRecord["status"] | undefined;
    let consumed: boolean;
    let read: string;
    try {
      // Occupy the only slot, so the queried run cannot start until we open the gate.
      await spawn("slot-holder");
      const queuedId = agentId(await spawn("queued-target"));
      if (!queuedId) throw new Error("Test setup: the queued launch returned no agent ID");
      id = queuedId;
      read = await Promise.race([
        call("get_subagent_result", "read-queued", { agent_id: id }).then(textOf),
        flush().then(() => "Read still pending while the child was blocked"),
      ]);
      const record = manager.getRecord(id);
      status = record?.status;
      consumed = Boolean(record?.resultConsumed);
    } finally {
      finish.open();
      await manager.waitForAll();
    }
    // Advance time only now, to deliver the notification after the read snapshot.
    await vi.advanceTimersByTimeAsync(NOTIFICATION_HOLD_MS);

    expect.soft({ status, consumed, read }, "A read must return the pending status before the child is released, not 'No output.'").toEqual({
      status: "queued",
      consumed: false,
      read: expect.stringMatching(/^(?![\s\S]*\bNo output\b)[\s\S]*\bStatus:\s*queued\b/i),
    });
    expect(host.pi.sendMessage, "An early read must not suppress the queued agent's completion notification").toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification", content: expect.stringContaining(id) }),
      expect.anything(),
    );
  });
});
