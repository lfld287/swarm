/**
 * subagents-print-mode-e2e.test.ts — REAL end-to-end subagent runs through the
 * headless print-mode host (`test/helpers/print-mode-runner.ts`).
 *
 * Unlike agent-runner-e2e / ext-templates-e2e (which assert on the gated tool
 * set captured at construction and never drive a turn), these tests drive a real
 * parent turn that calls the `Agent` tool, lets the extension spawn a real child
 * session via the real `runAgent`, and waits for it through the real subagent
 * hold condition — then asserts on what actually flowed back.
 *
 * Deterministic by default: a scripted faux model drives both parent and child
 * (no network). The same runner also drives a real LLM when PI_E2E_LIVE=1 — the
 * `live` describe below is a smoke test for that opt-in path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testAgentFile } from "./helpers/boot-extension.js";
import {
  agentCall,
  agentToolCalls,
  agentToolResults,
  completionText,
  conversationText,
  invokedToolNames,
  isSubagentContext,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
  settledAgent,
  toolResultsNamed,
} from "./helpers/print-mode-runner.js";

// Real pi-mono (loader + dynamic extension import + two live sessions) — a cold
// run under full-suite CPU contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

describe.skipIf(LIVE)("subagents print-mode e2e (scripted faux, real pi-mono)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // The one assumption the model/thinking display rests on, checked against a
  // REAL AgentSession rather than a stub: that a child session exposes the model
  // it resolved and the level it settled on, and that the manager writes both
  // onto the record. Every unit test in that area stubs the session, so nothing
  // else would notice pi moving or renaming either getter — the display would
  // just quietly go blank, which is the bug this whole area exists to fix.
  it("records the model and thinking level the child session actually resolved", async () => {
    run = await runPrintMode({
      agentFiles: { worker: testAgentFile("worker") },
      prompt: "Delegate the greeting to a subagent.",
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "worker",
          description: "greet",
          prompt: "Say hello.",
        }),
        parentFinal: "done",
        subagent: "CHILD_GREETING_OK",
      }),
    });
    await run.manager?.waitForAll();

    // The background result names the id; the record behind it is the real one
    // the extension built from the real child session.
    const id = /Agent ID: (\S+)/.exec(agentToolResults(run.parentSession).join("\n"))?.[1];
    expect(id).toBeTruthy();
    const record = run.manager?.getRecord(id as string) as { invocation?: Record<string, unknown> };
    const invocation = record?.invocation;

    // faux/faux-1 is what the harness registers and the child inherits, so this
    // is the resolved identity travelling through the real code path.
    expect(invocation?.modelId).toBe("faux/faux-1");
    expect(invocation?.modelName).toBe("faux-1");
    expect(typeof invocation?.thinking).toBe("string");
    expect(invocation?.thinking).not.toBe("");
  });

  it("wakes the idle parent through notification, not a synthetic prompt or the acceptance receipt", async () => {
    const parentSettled = Promise.withResolvers<void>();
    run = await runPrintMode({
      agentFiles: { worker: testAgentFile("worker") },
      prompt: "Delegate the greeting.",
      onParentSession: (session) => session.subscribe(event => {
        if (event.type === "agent_settled") parentSettled.resolve();
      }),
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "worker", description: "greet", prompt: "Say hello." }),
        parentFinal: (context) => context.messages.some(m => m.role === "user" && m.content.some(b =>
          b.type === "text" && b.text.includes("<task-notification>") && b.text.includes("CHILD_GREETING_OK")))
          ? "Parent relays: CHILD_GREETING_OK" : "Awaiting the child.",
        subagent: () => parentSettled.promise.then(() => "CHILD_GREETING_OK"),
      }),
    });
    expect(run.parentSession.messages.filter(m => m.role === "user")).toHaveLength(1);
    const [receipt] = agentToolResults(run.parentSession);
    const record = settledAgent(run);
    expect(receipt).toContain(`Agent ID: ${record.id}`);
    expect(receipt).not.toContain("CHILD_GREETING_OK");
    expect(completionText(run.parentSession)).toContain("CHILD_GREETING_OK");
    expect(run.responseText).toContain("Parent relays: CHILD_GREETING_OK");
  });

  it("holds a print-mode run until a gated child settles; without hold the parent can return first", async () => {
    const dir = { worker: testAgentFile("worker") };
    function gatedRun(hold: boolean) {
      const reachedParent = Promise.withResolvers<void>();
      const child = Promise.withResolvers<string>();
      const launch = runPrintMode({ agentFiles: dir, prompt: "go", hold, respond(context, state) {
        if (isSubagentContext(context)) return child.promise;
        return routeBySession({
          parentInitial: agentCall({ subagent_type: "worker", description: "bg work", prompt: "Do background work." }),
          parentFinal: () => { reachedParent.resolve(); return "Summarized."; },
          subagent: "unused",
        })(context, state);
      } });
      return { launch, reachedParent, child };
    }

    const detached = gatedRun(false);
    const noHold = await detached.launch;
    try {
      expect(noHold.manager?.hasRunning()).toBe(true);
    } finally {
      detached.child.resolve("No-hold answer");
      await noHold.manager?.waitForAll();
      await noHold.dispose();
    }

    const held = gatedRun(true);
    try {
      await held.reachedParent.promise;
      const snapshot = await Promise.race([
        held.launch.then(() => "returned"),
        new Promise<string>(resolve => setImmediate(() => resolve("still holding"))),
      ]);
      expect(snapshot).toBe("still holding");
    } finally {
      held.child.resolve("Held answer");
      run = await held.launch;
    }
    expect(settledAgent(run).result).toBe("Held answer");
  });

  it("spawns a FRONTMATTER-defined (.pi/agents/*.md) agent and its prompt reaches the child", async () => {
    // A project agent whose body is a distinctive system prompt. Proving the
    // child SAW it proves the full chain: the extension discovers the .md from
    // process.cwd(), parses its frontmatter, and runAgent's buildAgentPrompt
    // feeds the body into the real child session.
    const MARKER = "SPYMARKER_FRONTMATTER_REACHED_CHILD";
    const cwd = mkdtempSync(join(tmpdir(), "subagents-fm-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "echo-spy.md"),
      `---\ndescription: "Echoes a marker proving its frontmatter prompt reached the child."\n---\n${MARKER}\n`,
    );

    run = await runPrintMode({
      prompt: "Delegate to the echo-spy agent.",
      cwd, // runner chdir's here so the extension discovers echo-spy.md
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "echo-spy",
          description: "echo",
          prompt: "Report what you were told.",
        }),
        parentFinal: "Reported.",
        // The child reflects whether the frontmatter body reached its own prompt.
        subagent: (ctx: Context) =>
          `child saw: ${getCurrentSystemPrompt(ctx.messages).includes(MARKER) ? MARKER : "MISSING"}`,
      }),
    });

    const toolResults = agentToolResults(run.parentSession);
    expect(toolResults.length).toBe(1);
    expect(settledAgent(run).result).toContain(MARKER);
    expect(settledAgent(run).result).not.toContain("MISSING");
    // The custom type resolved — it did NOT silently fall back to another role.
    expect(toolResults[0]).not.toMatch(/Unknown agent type/i);
  });

  it("spawns a FRONTMATTER-defined (.agents/agents/*.md) agent and its prompt reaches the child", async () => {
    const MARKER = "SPYMARKER_AGENTS_FRONTMATTER_REACHED_CHILD";
    const cwd = mkdtempSync(join(tmpdir(), "subagents-agents-fm-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".agents", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".agents", "agents", "agents-spy.md"),
      `---\ndescription: "Echoes a marker from the .agents/agents workspace dir."\n---\n${MARKER}\n`,
    );

    run = await runPrintMode({
      prompt: "Delegate to the agents-spy agent.",
      cwd,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "agents-spy",
          description: "echo workspace",
          prompt: "Report what you were told.",
        }),
        parentFinal: "Reported.",
        subagent: (ctx: Context) =>
          `child saw: ${getCurrentSystemPrompt(ctx.messages).includes(MARKER) ? MARKER : "MISSING"}`,
      }),
    });

    const toolResults = agentToolResults(run.parentSession);
    expect(toolResults.length).toBe(1);
    expect(settledAgent(run).result).toContain(MARKER);
    expect(settledAgent(run).result).not.toContain("MISSING");
    expect(toolResults[0]).not.toMatch(/Unknown agent type/i);
  });

  it("a colored agent's name badge never reaches print-mode text", async () => {
    // Badges are a TUI concern: print mode renders no tool components, and the text the
    // model and `pi -p` see is built from plain display names. An escape sequence here
    // would mean color leaking into transcripts, headless output and the parent prompt.
    const cwd = mkdtempSync(join(tmpdir(), "subagents-color-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "painted.md"),
      '---\nname: Painted Agent\ncolor: purple\ndescription: "A colored agent."\n---\nBe brief.\n',
    );

    run = await runPrintMode({
      prompt: "Delegate to the painted agent.",
      cwd,
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "Painted Agent",
          description: "paint",
          prompt: "Report in.",
        }),
        parentFinal: "Done.",
        subagent: "Painted Agent reporting in.",
      }),
    });

    const result = settledAgent(run).result;
    expect(result).toContain("Painted Agent reporting in."); // the escape check below is not vacuous
    expect(result).not.toContain("\u001b");
    expect(conversationText(run.parentSession)).not.toContain("\u001b");
  });

  it("errors clearly when faux mode is given no script", async () => {
    await expect(runPrintMode({ prompt: "x" })).rejects.toThrow(/provide `respond` or `steps`/);
  });

  it("times out with the runner's own descriptive error and restores the environment", async () => {
    const prevCwd = process.cwd();
    // A responder that never resolves — the turn stalls until the wall-clock guard fires.
    await expect(
      runPrintMode({ prompt: "stall", respond: () => new Promise(() => {}), timeoutMs: 300 }),
    ).rejects.toThrow(/print-mode runner timed out after 300ms/);
    // The failure path ran dispose(): cwd and global isolation were restored even
    // though the caller never received a dispose handle.
    expect(process.cwd()).toBe(prevCwd);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")]).toBeUndefined();
  });

  // The unit tests stub `session.agent.streamFunction`; these read the retention
  // where pi hands the request to the provider. They fail if pi stops routing a
  // turn through `agent.streamFunction`, or captures it before the wrapper lands.
  describe("prompt cache retention reaches the provider", () => {
    /** Run one spawn of `type`; return the retention each request carried, by session. */
    async function retentions(cwd: string, type: string) {
      const seen = { parent: [] as unknown[], child: [] as unknown[] };
      const route = routeBySession({
        parentInitial: agentCall({ subagent_type: type, description: "cache", prompt: "Reply." }),
        parentFinal: "Done.",
        subagent: "ok",
      });
      run = await runPrintMode({
        prompt: "Delegate.",
        cwd,
        respond: (context, state, options) => {
          seen[isSubagentContext(context) ? "child" : "parent"].push(options?.cacheRetention);
          return route(context, state);
        },
        live: false,
      });
      return seen;
    }

    function projectDir(prefix: string) {
      const cwd = mkdtempSync(join(tmpdir(), prefix));
      tmpDirs.push(cwd);
      mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
      return cwd;
    }

    it("an agent's cache_retention frontmatter reaches its requests, not the parent's", async () => {
      const cwd = projectDir("subagents-cache-fm-");
      writeFileSync(
        join(cwd, ".pi", "agents", "cache-spy.md"),
        "---\ndescription: Replies.\ncache_retention: short\n---\nReply ok.\n",
      );

      const seen = await retentions(cwd, "cache-spy");

      expect(seen.child.length).toBeGreaterThan(0);
      expect(seen.child.every((r) => r === "short")).toBe(true);
      expect(seen.parent.length).toBeGreaterThan(0);
      expect(seen.parent.every((r) => r === undefined)).toBe(true);
    });

    it("the cacheRetention setting reaches a custom agent's requests, not the parent's", async () => {
      const cwd = projectDir("subagents-cache-setting-");
      writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ cacheRetention: "long" }));

      writeFileSync(join(cwd, ".pi", "agents", "worker.md"), testAgentFile("worker"));
      const seen = await retentions(cwd, "worker");

      expect(seen.child.length).toBeGreaterThan(0);
      expect(seen.child.every((r) => r === "long")).toBe(true);
      expect(seen.parent.length).toBeGreaterThan(0);
      expect(seen.parent.every((r) => r === undefined)).toBe(true);
    });
  });
});

// Opt-in real-LLM smoke tests — exercise the SAME runner against a live model
// (auto-resolved from the local `pi` login). Skipped unless PI_E2E_LIVE=1.
//
// These are SMOKE tests, not strict assertions: a live model decides whether and
// how to call the tool, so we cover the subset it can be reliably steered into
// (background spawn, get_subagent_result, a Surveyor spawn)
// and assert robust invariants (a real spawn happened and produced output).
// Per-feature determinism lives in the faux suite above, which scripts exact calls.
// One spawn includes the parent's dispatch and follow-up, a child request,
// and (for retrieval) another parent tool round. Keep the existing live
// budget; a fixture accidentally selecting a different provider is not latency.
const LIVE_TIMEOUT = 150_000;
// SELF-SMOKE chains three spawns and their parent turns under one guard.
const SELF_SMOKE_TIMEOUT = 600_000;
// The vitest per-test timer starts before runPrintMode and should not fire
// first: the runner's own timeoutMs guard produces a descriptive error and
// aborts the live session + subagents, while a vitest timeout is generic and
// leaks them. The slack covers live setup/teardown outside the runner's guard.
const VITEST_SLACK = 30_000;
const LIVE_VITEST_TIMEOUT = LIVE_TIMEOUT + VITEST_SLACK;
const SELF_SMOKE_VITEST_TIMEOUT = SELF_SMOKE_TIMEOUT + VITEST_SLACK;

// Live needs the local model registry/auth. Give the model an unambiguous
// fixture type rather than a name shared with a global Worker and its model pin.
const LIVE_ECHO_TYPE = "print-mode-echo";
const WAIT_FOR_NOTIFICATION = "End the current turn after dispatch; do not poll, sleep, or respawn. On completion notification, ";
const DISPATCH_ARGS = "Pass only subagent_type, description, and prompt to Agent. ";

function liveSmoke(prompt: string, timeoutMs = LIVE_TIMEOUT) {
  return runPrintMode({
    agentFiles: { [LIVE_ECHO_TYPE]: testAgentFile(LIVE_ECHO_TYPE), Surveyor: testAgentFile("Surveyor", "read, ls") },
    // A user's custom Agent description may advertise removed tool arguments.
    // Exercise the current built-in description without changing local config.
    beforeRun: () => writeFileSync(join(".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" })),
    prompt,
    timeoutMs,
  });
}

describe.runIf(LIVE)("subagents print-mode e2e (live LLM, opt-in)", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it(
    "Background spawn — real model spawns a subagent and reports its output",
    async () => {
      run = await liveSmoke(
        `Use the Agent tool with subagent_type '${LIVE_ECHO_TYPE}' to get the exact word PONG. ` +
        `${DISPATCH_ARGS}${WAIT_FOR_NOTIFICATION}tell me what the subagent replied. Do not use get_subagent_result for this test.`,
      );
      expect(run.modelCalls).toBe(0); // live mode doesn't use the faux counter
      expect(invokedToolNames(run.parentSession)).toContain("Agent");
      expect(settledAgent(run)).toMatchObject({ type: LIVE_ECHO_TYPE, result: expect.stringMatching(/PONG/i) });
      expect(completionText(run.parentSession)).toMatch(/PONG/i);
      expect(run.responseText).toMatch(/PONG/i);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "BACKGROUND spawn + get_subagent_result — model backgrounds work then retrieves it",
    async () => {
      run = await liveSmoke(
        `Use the Agent tool with subagent_type '${LIVE_ECHO_TYPE}' to get the exact word BGPONG. ` +
        `${DISPATCH_ARGS}${WAIT_FOR_NOTIFICATION}call get_subagent_result with only agent_id, then tell me exactly what it said.`,
      );
      const calls = agentToolCalls(run.parentSession);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => !Object.hasOwn(c, "run_in_background"))).toBe(true);
      expect(agentToolResults(run.parentSession).join("\n")).toMatch(/background/i);
      expect(invokedToolNames(run.parentSession)).toContain("get_subagent_result");
      const record = settledAgent(run);
      expect(record).toMatchObject({ type: LIVE_ECHO_TYPE, result: expect.stringMatching(/BGPONG/i) });
      expect(toolResultsNamed(run.parentSession, "get_subagent_result")).toEqual(expect.arrayContaining([
        expect.stringContaining(`\n\n${record.result?.trim()}`),
      ]));
      expect(run.responseText).toMatch(/BGPONG/i);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "Surveyor subagent_type — model dispatches a custom agent type",
    async () => {
      run = await liveSmoke(
        "Use the Agent tool with subagent_type 'Surveyor' to look at the current working " +
        `directory. ${DISPATCH_ARGS}${WAIT_FOR_NOTIFICATION}report a one-line summary of what's there.`,
      );
      const calls = agentToolCalls(run.parentSession);
      // The custom type was actually selected (case-insensitive per README).
      expect(
        calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "surveyor"),
      ).toBe(true);
      expect(run.responseText.length).toBeGreaterThan(0);
    },
    LIVE_VITEST_TIMEOUT,
  );

  it(
    "SELF-SMOKE — the agent drives a multi-feature smoke of its own Agent toolset",
    async () => {
      // Agent-driven (not puppeted): one prompt, the model itself exercises three
      // Agent capabilities in a single session and self-reports. We then assert it
      // genuinely invoked each feature (not just that it claimed to in prose).
      run = await liveSmoke([
        "You are smoke-testing your own Agent toolset. Do these steps IN ORDER, then print a",
        "final report with one PASS/FAIL line per step:",
        DISPATCH_ARGS.trim(),
        "After each dispatch, end your current turn and continue on notification. Do not poll, sleep, or respawn.",
        `1) NOTIFY: spawn a subagent with subagent_type '${LIVE_ECHO_TYPE}' whose only`,
        "   task is to reply with the exact token NOTIFY_OK. Confirm it after the completion notification.",
        `2) READ: spawn a subagent with subagent_type '${LIVE_ECHO_TYPE}' whose only`,
        "   task is to reply with the exact token BG_OK. After it finishes, call get_subagent_result",
        "   to retrieve its output. Confirm you got BG_OK.",
        "3) EXPLORE: spawn a subagent with subagent_type 'Surveyor' to summarize the current",
        "   working directory in one line.",
        "Finish with: 'SELF-SMOKE COMPLETE' followed by the PASS/FAIL lines.",
      ].join("\n"), SELF_SMOKE_TIMEOUT);

      const calls = agentToolCalls(run.parentSession);
      const tools = invokedToolNames(run.parentSession);

      expect(calls.length).toBeGreaterThanOrEqual(3);
      // — the result-retrieval tool was called
      expect(tools).toContain("get_subagent_result");
      // — the Surveyor type was dispatched
      expect(calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "surveyor")).toBe(true);
      // — and the real child outputs materialized in the conversation (the
      //   completion notification + the get_subagent_result result). We check the
      //   whole transcript, not the final message: the agent's closing report
      //   tends to summarize ("Step 1 PASS") rather than re-echo the raw tokens.
      const transcript = conversationText(run.parentSession);
      expect(transcript).toMatch(/NOTIFY_OK/i);
      expect(transcript).toMatch(/BG_OK/i);
      // The agent ran the whole script to completion and self-reported. Checked
      // against the transcript, not `responseText`: step 2's background agent
      // completes asynchronously, so its completion nudge can land AFTER the
      // final report and draw one more turn out of the model ("Acknowledged, all
      // three steps PASS"). The report is then the second-to-last message and a
      // last-message assertion fails a run that did everything right.
      expect(transcript).toMatch(/SELF-SMOKE COMPLETE/i);
      expect(run.responseText.length).toBeGreaterThan(0);
    },
    SELF_SMOKE_VITEST_TIMEOUT,
  );
});
