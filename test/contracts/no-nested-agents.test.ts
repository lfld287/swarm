import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { hermeticDir } from "../helpers/boot-extension.js";
import { agentCall, type PrintModeRun, runPrintMode } from "../helpers/print-mode-runner.js";

it("withholds orchestration tools from the child and rejects its Agent call even with allowed_subagents", async () => {
  const project = hermeticDir({
    settings: { outputTranscript: false, defaultJoinMode: "async" },
    agentFiles: {
      delegator: "---\ndescription: Contract delegator\ntools: read\nextensions: false\nallowed_subagents: worker\n---\nTry delegation.\n",
      worker: "---\ndescription: Contract worker\ntools: read\nextensions: false\n---\nDo the work.\n",
    },
  });
  let run: PrintModeRun | undefined;
  let offered: string[] | undefined;
  let childCall: { isError: boolean; text: string } | undefined;
  const orchestrationTools = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

  try {
    run = await runPrintMode({
      cwd: project.dir,
      isolateGlobals: false, // hermeticDir already isolates HOME and PI_CODING_AGENT_DIR.
      live: false,
      prompt: "Run the delegator.",
      respond(context) {
        const systemPrompt = getCurrentSystemPrompt(context.messages);
        if (systemPrompt.includes('<active_agent name="worker"/>')) return "Nested worker ran.";
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "Agent");
        if (systemPrompt.includes('<active_agent name="delegator"/>')) {
          if (result?.role === "toolResult") {
            childCall = {
              isError: result.isError,
              text: result.content.map((block) => block.type === "text" ? block.text : "").join("\n"),
            };
            return "Delegation probe finished.";
          }
          offered = getCurrentTools(context.messages).map((tool) => tool.name).filter((name) => orchestrationTools.has(name));
          // Attempt the call even when Agent was not advertised, to test enforcement.
          return agentCall({ subagent_type: "worker", description: "Nested probe", prompt: "Run the nested probe." });
        }
        if (result) return "Done.";
        return agentCall({ subagent_type: "delegator", description: "Top-level delegator", prompt: "Attempt to delegate." });
      },
    });

    expect({ offered, childCall }, "A child session must neither see orchestration tools nor be able to call Agent").toEqual({
      offered: [],
      childCall: expect.objectContaining({ isError: true }),
    });
  } finally {
    try {
      await run?.dispose();
    } finally {
      project.restore();
    }
  }
});
