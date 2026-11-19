/**
 * subagent-error-status-e2e.test.ts — regression for issue #144: a subagent
 * whose final assistant turn is a provider error must be reported as a
 * failure, not as "completed" with an empty (or stale) result.
 *
 * Full-stack: real pi loader + real extension + real runAgent + real child
 * sessions on a faux model. Faux is the point, not a shortcut — the scenario is
 * a provider error with zero content, which no live model will produce on
 * request. Each run pins `live: false` so the pre-publish smoke's global
 * `PI_E2E_LIVE=1` can't swap a real model in and turn this suite red.
 */
import { type Context, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testAgentFile } from "./helpers/boot-extension.js";
import {
  agentCall,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
  settledAgent,
  toolResultsNamed,
} from "./helpers/print-mode-runner.js";

/** Ask the actual result tool only after the matching completion reaches the parent. */
function readAfterNotification(context: Context) {
  if (context.messages.some(m => m.role === "toolResult" && m.toolName === "get_subagent_result")) return "Read.";
  for (const m of context.messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (b.type !== "text" || !b.text.includes("<task-notification>")) continue;
      const id = /<task-id>([^<]+)<\/task-id>/.exec(b.text)?.[1];
      if (id) return fauxToolCall("get_subagent_result", { agent_id: id });
    }
  }
  return "Waiting for notification.";
}

vi.setConfig({ testTimeout: 30_000 });

// Not matched by pi's transient-error patterns → no auto-retry, deterministic.
const FATAL = "invalid request: provider rejected the prompt";

describe("issue #144 — empty-error final turns must not be 'completed'", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("a run whose ONLY turn errors with no output is a failure, not an empty success", async () => {
    run = await runPrintMode({
      agentFiles: { worker: testAgentFile("worker") },
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "worker", description: "doomed", prompt: "Do work." }),
        parentFinal: readAfterNotification,
        // The child's one and only turn: provider error, zero content.
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
      live: false,
    });

    // DESIRED: the orchestrator sees a failure naming the provider error —
    // not a clean success reading "No output.".
    expect(settledAgent(run)).toMatchObject({ status: "error", error: FATAL });
    const [toolResult] = toolResultsNamed(run.parentSession, "get_subagent_result");
    expect(toolResult).toContain(FATAL);
    expect(toolResult).not.toContain("No output.");
  });

  it("an earlier turn's text must not mask a failed final turn as a fresh success", async () => {
    run = await runPrintMode({
      agentFiles: { worker: testAgentFile("worker") },
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "worker", description: "masked", prompt: "Do work." }),
        parentFinal: readAfterNotification,
        subagent: (ctx) => {
          const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
          // Turn 1: real text + a tool call. Turn 2 (after the tool result):
          // provider error with zero content.
          return hasToolResult
            ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL })
            : fauxAssistantMessage([
                fauxText("EARLIER-PARTIAL-TEXT"),
                fauxToolCall("bash", { command: "echo hi" }),
              ]);
        },
      }),
      live: false,
    });

    // The orchestrator sees the failure (not the earlier text as a clean
    // answer), AND the partial output is salvaged, clearly labeled as
    // pre-failure so it can't be mistaken for the final answer.
    expect(settledAgent(run)).toMatchObject({ status: "error", error: FATAL });
    const [toolResult] = toolResultsNamed(run.parentSession, "get_subagent_result");
    expect(toolResult).toContain(FATAL);
    expect(toolResult).toContain("Partial output before the failure:");
    expect(toolResult).toContain("EARLIER-PARTIAL-TEXT");
    // The failure headline comes before the salvaged partial output.
    expect(toolResult.indexOf(FATAL)).toBeLessThan(toolResult.indexOf("EARLIER-PARTIAL-TEXT"));
  });

  it("a pure empty-error run shows no 'partial output' section", async () => {
    run = await runPrintMode({
      agentFiles: { worker: testAgentFile("worker") },
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ subagent_type: "worker", description: "empty", prompt: "Do work." }),
        parentFinal: readAfterNotification,
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
      live: false,
    });

    expect(settledAgent(run)).toMatchObject({ status: "error", error: FATAL });
    const [toolResult] = toolResultsNamed(run.parentSession, "get_subagent_result");
    expect(toolResult).toContain(FATAL);
    expect(toolResult).not.toContain("Partial output before the failure:");
  });
});
