/**
 * evicted-resume.test.ts — resuming an agent whose live record is gone.
 *
 * The manager evicts a finished record ten minutes after it settles, and a
 * reload or restart drops it at once, but the agent's conversation is still in
 * its saved pi session. `Agent({ resume })` reopens it from the session's
 * `subagents:record` entry under the same id (#331, #385).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { agentRecordEntryData, worktreeLost } from "../src/agent-record-entry.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, type Hermetic, hermeticDir, makePi, publishedManager, testAgentFile, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;
let sessionDir: string;
/** The child's saved pi session — a real file, since a reopen checks it exists. */
let sessionFile: string;

beforeEach(() => {
  // No transcripts: they would stream from the stub session's events.
  hermetic = hermeticDir({ agentFiles: { Surveyor: testAgentFile("Surveyor") }, settings: { schedulingEnabled: false, outputTranscript: false } });
  sessionDir = mkdtempSync(join(tmpdir(), "pi-evicted-resume-"));
  sessionFile = join(sessionDir, "child.jsonl");
  writeFileSync(sessionFile, "");
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  rmSync(sessionDir, { recursive: true, force: true });
});

/** A finished run whose session was saved to `file` (or kept in memory, for undefined). */
function settleWith(text: string, file: string | undefined) {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
    const session = {
      dispose: vi.fn(),
      messages: [],
      subscribe: vi.fn(() => () => {}),
      sessionManager: { getSessionFile: () => file },
    } as any;
    options.onSessionCreated?.(session);
    return { responseText: text, session, aborted: false, steered: false };
  });
}

/** Boot the extension with `appendEntry` landing on `branch`, as pi's session does. */
function boot(branch: any[]) {
  const { pi, tools, lifecycle } = makePi();
  pi.appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  subagentsExtension(pi);
  booted = lifecycle;
  const context = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
  const agent = (params: Record<string, unknown>) =>
    tools.get("Agent").execute("tc", { description: "Review the change", subagent_type: "Surveyor", ...params }, undefined, undefined, context);
  const read = (id: string) => tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, context);
  return { agent, read, lifecycle, manager: publishedManager() };
}

/**
 * Run an agent to completion in one activation, shut it down, and return its
 * id. `inMemory` keeps its session off disk, as `rememberAgents: false` does.
 */
async function finishedAgent(branch: any[], { inMemory = false } = {}): Promise<string> {
  settleWith("FIRST-RUN", inMemory ? undefined : sessionFile);
  const { agent, lifecycle } = boot(branch);
  const res = await agent({ prompt: "Review the change." });
  await publishedManager().waitForAll();
  await lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  return (res as any).details.agentId;
}

describe("Agent({ resume }) once the live record is gone", () => {
  it("reopens the saved session after a reload, under the same id", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    settleWith("RESUMED-RUN", sessionFile);
    const { agent, read, manager } = boot(branch);
    const res = await agent({ prompt: "Now check the tests.", resume: id });
    await manager.waitForAll();

    const [, type, prompt, options] = vi.mocked(runAgent).mock.lastCall!;
    expect(type).toBe("Surveyor");
    expect(prompt).toBe("Now check the tests.");
    expect(options.resumeSessionFile).toBe(sessionFile);
    expect(options.agentId).toBe(id);
    expect((res as any).details.agentId).toBe(id);
    expect(textOf(await read(id))).toContain("RESUMED-RUN");
  });

  it("reopens in the background and reports the same id", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    settleWith("RESUMED-RUN", sessionFile);
    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(textOf(res)).toContain("resumed from its saved session in background");
    expect(textOf(res)).toContain(`Agent ID: ${id}`);
    expect(vi.mocked(runAgent).mock.lastCall![3].resumeSessionFile).toBe(sessionFile);
  });

  it("reopens an agent the ten-minute cleanup evicted in this activation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const branch: any[] = [];
    settleWith("FIRST-RUN", sessionFile);
    const { agent, manager } = boot(branch);
    const id = (await agent({ prompt: "Review the change." }) as any).details.agentId;

    await manager.waitForAll();
    vi.advanceTimersByTime(11 * 60_000);
    expect(manager.getRecord(id)).toBeUndefined();

    settleWith("RESUMED-RUN", sessionFile);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(vi.mocked(runAgent).mock.lastCall![3].resumeSessionFile).toBe(sessionFile);
    expect((res as any).details.agentId).toBe(id);
  });

  it("appends to the agent's transcript instead of starting it over", async () => {
    writeFileSync(join(hermetic!.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: true }));
    const branch: any[] = [];
    settleWith("FIRST-RUN", sessionFile);
    const first = boot(branch);
    const res = await first.agent({ prompt: "Review the change." });
    const id = (res as any).details.agentId;
    const transcript = first.manager.getRecord(id)!.outputFile!;
    await publishedManager().waitForAll();
    await first.lifecycle.get("session_shutdown")?.();
    delete (globalThis as any)[MANAGER_KEY];

    settleWith("RESUMED-RUN", sessionFile);
    const { agent } = boot(branch);
    await agent({ prompt: "Continue.", resume: id });

    expect(readFileSync(transcript, "utf-8")).toContain("Review the change.");
  });

  it("gives the reopened agent a fresh handle when a live agent took its old one", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    settleWith("OTHER", undefined);
    const { agent, manager } = boot(branch);
    const other = (await agent({ prompt: "Something else." }) as any).details.agentId;
    expect(manager.getRecord(other).handle).toBe("surveyor");

    settleWith("RESUMED-RUN", sessionFile);
    await agent({ prompt: "Continue.", resume: id });

    expect(manager.getRecord(id).handle).not.toBe("surveyor");
  });

  it("stays resumable after a reopen that failed before its session existed", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    // The reopen dies before pi hands back a session, so the run never learns
    // which file it was continuing. Its saved record must still name one.
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("provider unavailable"));
    const second = boot(branch);
    await second.agent({ prompt: "Continue.", resume: id });
    await publishedManager().waitForAll();
    await second.lifecycle.get("session_shutdown")?.();
    delete (globalThis as any)[MANAGER_KEY];

    settleWith("RESUMED-RUN", sessionFile);
    const { agent, read, manager } = boot(branch);
    const res = await agent({ prompt: "Try again.", resume: id });
    expect(res.details.agentId).toBe(id);
    await manager.waitForAll();

    expect(vi.mocked(runAgent).mock.lastCall![3].resumeSessionFile).toBe(sessionFile);
    expect(textOf(await read(id))).toContain("RESUMED-RUN");
  });

  it("refuses, starting nothing, when the saved session file is gone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    rmSync(sessionFile);

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(textOf(res)).toBe(`Agent "${id}" cannot be resumed — its session is gone.`);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses, starting nothing, when the agent kept no saved session", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch, { inMemory: true });

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(textOf(res)).toContain(`Agent "${id}" cannot be resumed — its conversation was not saved`);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses, starting nothing, when the agent's work lived in a worktree that is gone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    branch.at(-1).data.worktreeLost = true;

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(textOf(res)).toBe(`Agent "${id}" cannot be resumed — its worktree no longer exists.`);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("still refuses to combine resume with schedule", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    writeFileSync(join(hermetic!.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: true, outputTranscript: false }));

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id, schedule: "+5m" });

    expect(textOf(res)).toContain("Cannot combine `schedule` with `resume`");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("still reports an id with no saved record as not found", async () => {
    const branch: any[] = [];
    await finishedAgent(branch);

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: "3f1320a7-74ec-422" });

    expect(textOf(res)).toContain("Agent not found");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe("Agent({ resume }) of an evicted agent keeps its own model and thinking (#462)", () => {
  const modelA = { provider: "pA", id: "model-a", name: "Model A" };
  const modelB = { provider: "pB", id: "model-b", name: "Model B" };
  const registry = {
    find: (provider: string, id: string) => [modelA, modelB].find(m => m.provider === provider && m.id === id),
    getAll: () => [modelA, modelB],
    getAvailable: () => [modelA, modelB],
  };

  /** A finished run reporting an effective model and thinking level on its session. */
  function settleWithSession(text: string, file: string, model: unknown, thinkingLevel: string) {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      const session = {
        dispose: vi.fn(),
        messages: [],
        subscribe: vi.fn(() => () => {}),
        sessionManager: { getSessionFile: () => file },
        model,
        thinkingLevel,
      } as any;
      options.onSessionCreated?.(session);
      return { responseText: text, session, aborted: false, steered: false };
    });
  }

  /** Boot the extension with the parent session on `parentModel` / `parentThinking`. */
  function bootWith(branch: any[], parentModel: unknown, parentThinking: string) {
    const { pi, tools, lifecycle } = makePi();
    pi.appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
    subagentsExtension(pi);
    booted = lifecycle;
    const context = ctx({
      model: parentModel,
      modelRegistry: registry,
      thinkingLevel: parentThinking,
      sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) },
    });
    const agent = (params: Record<string, unknown>) =>
      tools.get("Agent").execute("tc", { description: "Review the change", subagent_type: "Surveyor", ...params }, undefined, undefined, context);
    return { agent, lifecycle };
  }

  /**
   * Run an agent on model B / high while the parent is on A / medium, then shut
   * down so the next activation finds only its saved record. Returns its id.
   */
  async function ranOnB(branch: any[], params: Record<string, unknown> = { model: "pB/model-b", thinking: "high" }): Promise<string> {
    settleWithSession("FIRST-RUN", sessionFile, modelB, "high");
    const first = bootWith(branch, modelA, "medium");
    const res = await first.agent({ prompt: "Review the change.", ...params });
    await publishedManager().waitForAll();
    await first.lifecycle.get("session_shutdown")?.();
    delete (globalThis as any)[MANAGER_KEY];
    booted = undefined;
    return (res as any).details.agentId;
  }

  // runAgent is mocked here, so what is asserted is the hand-off: the reopen
  // passes no model or level, which is what lets runAgent leave both to the
  // reopened session (see agent-runner.test.ts), where pi restores B / high.

  it("passes neither the parent's model nor its thinking level to the reopen", async () => {
    const branch: any[] = [];
    const id = await ranOnB(branch);

    settleWithSession("RESUMED-RUN", sessionFile, modelB, "high");
    const { agent } = bootWith(branch, modelA, "medium");
    const res = await agent({ prompt: "Now check the tests.", resume: id });
    await publishedManager().waitForAll();

    const options = vi.mocked(runAgent).mock.lastCall![3] as any;
    expect(options.resumeSessionFile).toBe(sessionFile);
    expect(options.model).toBeUndefined();
    expect(options.thinkingLevel).toBeUndefined();
    expect(res.details.agentId).toBe(id);
    expect(publishedManager().getRecord(id)?.invocation?.modelName).toBe("model b");
  });

  it("does not apply a model or thinking level passed with the resume", async () => {
    const branch: any[] = [];
    const id = await ranOnB(branch);

    settleWithSession("RESUMED-RUN", sessionFile, modelB, "high");
    const { agent } = bootWith(branch, modelA, "medium");
    await agent({ prompt: "Continue.", resume: id, model: "pA/model-a", thinking: "low" });

    const options = vi.mocked(runAgent).mock.lastCall![3] as any;
    expect(options.model).toBeUndefined();
    expect(options.thinkingLevel).toBeUndefined();
  });

  it("does not apply the agent file's model or thinking level to the reopen", async () => {
    // A live resume keeps its session's model whatever the file now says; a
    // reopen must too, or a file edited since the run would switch it.
    const agentsDir = join(hermetic!.dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "pinned.md"), "---\ndescription: Pinned\nmodel: pA/model-a\nthinking: low\n---\nYou are pinned.\n");
    const branch: any[] = [];
    const id = await ranOnB(branch, { subagent_type: "pinned" });

    settleWithSession("RESUMED-RUN", sessionFile, modelB, "high");
    const { agent } = bootWith(branch, modelA, "medium");
    await agent({ prompt: "Continue.", resume: id });

    const options = vi.mocked(runAgent).mock.lastCall![3] as any;
    expect(vi.mocked(runAgent).mock.lastCall![1]).toBe("pinned");
    expect(options.model).toBeUndefined();
    expect(options.thinkingLevel).toBeUndefined();
  });
});

describe("worktreeLost", () => {
  const wt = { path: "/wt/a", branch: "pi-agent-a", baseSha: "abc", workPath: "/wt/a" };

  it("is set only when a worktree held the agent's work", () => {
    expect(worktreeLost({})).toBe(false);
    expect(worktreeLost({ worktree: wt, worktreeResult: { hasChanges: false } })).toBe(false);
    expect(worktreeLost({ worktree: wt, worktreeResult: { hasChanges: true, branch: "pi-agent-a" } })).toBe(true);
    // Failed before cleanup reported anything: its edits may be anywhere.
    expect(worktreeLost({ worktree: wt })).toBe(true);
  });

  it("is saved in the record entry only when set", () => {
    const base = { id: "a", type: "Surveyor", description: "d", status: "completed", startedAt: 0 } as AgentRecord;
    expect(agentRecordEntryData(base)).not.toHaveProperty("worktreeLost", expect.anything());
    expect(agentRecordEntryData({ ...base, worktree: wt, worktreeResult: { hasChanges: true } }).worktreeLost).toBe(true);
  });
});

describe("reclaiming an id", () => {
  it("refuses an id that is still live, rather than replacing its record", async () => {
    settleWith("FIRST-RUN", sessionFile);
    const manager = new AgentManager();
    const id = manager.spawn({} as any, ctx(), "worker", "go", { description: "first" });

    expect(() =>
      manager.spawn({} as any, ctx(), "worker", "again", { description: "second", reclaim: { id }, resumeSessionFile: sessionFile }),
    ).toThrow(id);
    expect(manager.getRecord(id)?.description).toBe("first");
    await manager.dispose();
  });
});
