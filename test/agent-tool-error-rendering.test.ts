import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function render(tool: any, result: any): string {
  return tool.renderResult(
    { content: result.content, details: result.details },
    { expanded: false, isPartial: false },
    theme,
    { isError: result.isError },
  ).render(120).join("\n");
}

describe("Agent tool invocation error rendering", () => {
  it("shows a Pi tool error instead of structured terminal status", () => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: 'Cannot run with isolation: "worktree" — Git probe failed.' }],
      isError: true,
      details: { status: "aborted" },
    });

    expect(output).toContain('Cannot run with isolation: "worktree" — Git probe failed.');
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });

  it.each([
    ["missing details", undefined],
    ["empty details", {}],
    ["unknown status", { status: "unknown" }],
    ["a status with no rendering of its own", { status: "queued" }],
  ])("shows the real result text for %s", (_name, details) => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: "Unstructured Agent result." }],
      isError: false,
      details,
    });

    expect(output).toContain("Unstructured Agent result.");
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });
});

describe("Agent tool result rendering for saved receipts", () => {
  it("shows the saved result text for a completed agent", () => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: "Saved agent output." }],
      details: { agentId: "a1", status: "completed" },
      isError: false,
    });

    expect(output).toContain("Saved agent output.");
    expect(output).not.toContain("Running in background");
  });

  it.each([
    ["queued", "Queued"],
    ["running", "Running"],
  ])("shows the background status line for a %s agent", (status, label) => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: "Agent receipt text." }],
      details: { agentId: "a1", status },
      isError: false,
    });

    expect(output).toContain(`${label} in background (ID: a1)`);
    expect(output).not.toContain("Agent receipt text.");
  });
});
