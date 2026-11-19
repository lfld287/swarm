import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunResult, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, testAgentFile } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAgent: vi.fn(),
}));

describe("/agents create wizard", () => {
  let project: Hermetic;
  let host: BootedPi;
  let finish: (() => void) | undefined;

  afterEach(async () => {
    finish?.();
    finish = undefined;
    await host?.lifecycle.get("session_shutdown")?.();
    project?.restore();
    vi.mocked(runAgent).mockReset();
  });

  function boot(agentFiles?: Record<string, string>) {
    project = hermeticDir({ agentFiles, settings: { schedulingEnabled: false, outputTranscript: false } });
    host = makePi();
    subagentsExtension(host.pi);
    const ui = {
      select: vi.fn<(title: string, options: string[]) => Promise<string | undefined>>(),
      input: vi.fn<() => Promise<string>>(),
      editor: vi.fn().mockResolvedValue("Summarize project notes."),
      notify: vi.fn(),
    };
    ui.select.mockResolvedValueOnce("Create new agent").mockResolvedValueOnce("Project (.pi/agents/)");
    const file = join(project.dir, ".pi", "agents", "notes.md");
    return { ui, file, open: () => host.commands.get("agents").handler("", ctx({ ui })) };
  }

  it.each([false, true])("creates a role manually when no generator is available (existing roles: %s)", async (existing) => {
    const { ui, file, open } = boot(existing ? { reader: testAgentFile("reader") } : undefined);
    if (existing) ui.select.mockResolvedValueOnce("Generate with an agent");
    ui.select.mockResolvedValueOnce("none").mockResolvedValueOnce("inherit (parent model)").mockResolvedValueOnce("inherit");
    ui.input.mockResolvedValueOnce("notes").mockResolvedValueOnce("Summarize notes");

    await open();

    expect(ui.select.mock.calls.some(([title]) => title === "Creation method")).toBe(existing);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/(generation needs|Generation needs).*write tool/), "info");
    expect(runAgent).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toContain("Summarize project notes.");
  });

  it("offers only enabled write-capable roles and reports the selected run's ID before it finishes", async () => {
    const { ui, file, open } = boot({
      reader: testAgentFile("reader"),
      author: testAgentFile("author", "read, write"),
      editor: testAgentFile("editor", "write"),
      disabled: "---\nenabled: false\ntools: write\n---\nDisabled.\n",
      denied: "---\ntools: all\ndisallowed_tools: Write\n---\nRead only.\n",
    });
    ui.select.mockResolvedValueOnce("Generate with an agent").mockResolvedValueOnce("editor");
    ui.input.mockResolvedValueOnce("Summarize notes").mockResolvedValueOnce("notes");
    vi.mocked(runAgent).mockImplementation(() => new Promise<RunResult>((resolve) => {
      finish = () => resolve({
        responseText: "Done.", session: { dispose: vi.fn() } as RunResult["session"], aborted: false, steered: false,
      });
    }));

    await open();

    expect(ui.select).toHaveBeenCalledWith("Choose an agent to generate the definition", ["author", "editor"]);
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "editor", expect.stringContaining(file), expect.anything());
    expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^Agent generation requested \(Agent ID: \S+\)\.$/), "info");
    expect(existsSync(file)).toBe(false);
  });
});
