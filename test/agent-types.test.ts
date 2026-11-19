import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAllTypes,
  getAvailableTypes,
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  getToolNamesForType,
  isValidType,
  NO_FALLBACK,
  registerAgents,
  resolveEnabledTypeIn,
  resolveSpawnType,
  resolveSpawnTypeIn,
  resolveType,
  setFallbackSubagent,
} from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    isolated: false,
    ...overrides,
  };
}

describe("custom role registry", () => {
  afterEach(() => {
    setFallbackSubagent(undefined);
    registerAgents(new Map());
  });

  function registerRoles(...roles: Partial<AgentConfig>[]) {
    registerAgents(new Map(roles.map(role => {
      const config = makeAgentConfig(role);
      return [config.name, config];
    })));
  }

  function refusal(type: unknown) {
    const result = resolveSpawnType(type);
    if (result.ok) throw new Error(`Unexpectedly resolved to ${result.type}`);
    expect(result.message).toMatch(/Define or enable a role in \.pi\/agents\/<name>\.md or \.agents\/agents\/<name>\.md/);
    return result.message;
  }

  it("starts with no roles and rejects with a reason, an empty list and repair instructions", () => {
    registerRoles();
    expect(getAllTypes()).toEqual([]);
    expect(getAvailableTypes()).toEqual([]);
    expect(refusal("worker")).toContain('Unknown, disabled, or ambiguous agent type: "worker". Available: (none).');
  });

  it("allows a custom role to use a former built-in name without inheriting any config", () => {
    registerRoles({ name: "general-purpose", description: "Local reviewer", builtinToolNames: ["read"] });
    expect(getAvailableTypes()).toEqual(["general-purpose"]);
    expect(getConfig("general-purpose")).toMatchObject({ description: "Local reviewer", builtinToolNames: ["read"] });
    expect(resolveSpawnType("general-purpose")).toEqual({ ok: true, type: "general-purpose" });
  });

  it("lists disabled roles only in all types and grants them no runtime config", () => {
    registerRoles({ name: "scout" }, { name: "retired", enabled: false, builtinToolNames: undefined });
    expect(getAllTypes()).toEqual(["scout", "retired"]);
    expect(getAvailableTypes()).toEqual(["scout"]);
    expect(getAgentConfig("retired")?.enabled).toBe(false);
    expect(isValidType("retired")).toBe(false);
    expect(refusal("retired")).toContain('"retired". Available: scout.');
    expect(getConfig("retired")).toBeUndefined();
    expect(getToolNamesForType("retired")).toEqual([]);
  });

  it("resolves exact names and unique case-insensitive matches", () => {
    registerRoles({ name: "Scout", displayName: "My scout", extensions: ["web-search"], skills: ["research"] });
    expect(resolveType("scout")).toBe("Scout");
    expect(isValidType("scout")).toBe(true);
    expect(resolveSpawnType(" SCOUT ")).toEqual({ ok: true, type: "Scout" });
    expect(getConfig("scout")).toMatchObject({ displayName: "My scout", extensions: ["web-search"], skills: ["research"] });
  });

  it("does not guess between case variants or skip a disabled exact match", () => {
    registerRoles({ name: "Scout" }, { name: "scout", enabled: false });
    expect(resolveSpawnType("Scout")).toEqual({ ok: true, type: "Scout" });
    expect(refusal("scout")).toContain('"scout". Available: Scout.');
    expect(refusal("SCOUT")).toContain('"SCOUT". Available: Scout.');
    expect(getConfig("SCOUT")).toBeUndefined();
  });

  it.each([undefined, "", "   ", NO_FALLBACK])("rejects unknown and missing types with fallback %s", fallback => {
    registerRoles({ name: "scout" });
    setFallbackSubagent(fallback);
    expect(refusal("typo")).toContain('"typo". Available: scout.');
    for (const missing of ["", "   ", undefined]) {
      expect(refusal(missing)).toContain("No agent type given. Available: scout.");
    }
  });

  it("supports a named enabled fallback without granting tools to the unresolved name", () => {
    registerRoles({ name: "scout" }, { name: "router", builtinToolNames: undefined });
    setFallbackSubagent(" ROUTER ");
    expect(resolveSpawnType("typo")).toEqual({ ok: true, type: "router", fellBackFrom: "typo" });
    expect(resolveSpawnType(undefined)).toEqual({ ok: true, type: "router", fellBackFrom: "" });
    expect(resolveSpawnType("SCOUT")).toEqual({ ok: true, type: "scout" });
    expect(getConfig("typo")).toBeUndefined();
    expect(getToolNamesForType("typo")).toEqual([]);
  });

  it.each(["missing", "retired", "SCOUT"])("names the invalid configured fallback %s and refuses", fallback => {
    registerRoles({ name: "Scout" }, { name: "scout" }, { name: "retired", enabled: false });
    setFallbackSubagent(fallback);
    expect(refusal("typo")).toContain(`fallbackSubagent "${fallback}" is unknown, disabled, or ambiguous. Available: Scout, scout.`);
  });

  it("keeps strict resolution separate from fallback when using an explicit registry", () => {
    const registry = new Map([["router", makeAgentConfig({ name: "router" })]]);
    setFallbackSubagent("router");
    expect(resolveEnabledTypeIn(registry, "typo")).toBeUndefined();
    expect(resolveEnabledTypeIn(registry, " ROUTER ")).toBe("router");
    expect(resolveSpawnTypeIn(registry, "typo")).toEqual({ ok: true, type: "router", fellBackFrom: "typo" });
  });

  it("grants all built-ins only when an enabled definition omits the field", () => {
    registerRoles(
      { name: "narrow", builtinToolNames: ["read", "grep"] },
      { name: "ext-only", builtinToolNames: [] },
      { name: "unrestricted", builtinToolNames: undefined },
    );
    expect(getToolNamesForType("narrow")).toEqual(["read", "grep"]);
    expect(getToolNamesForType("ext-only")).toEqual([]);
    expect(getToolNamesForType("unrestricted")).toEqual(BUILTIN_TOOL_NAMES);
  });

  describe("getMemoryToolNames", () => {
    it("returns read, write, edit when none exist", () => {
      const names = getMemoryToolNames(new Set());
      expect(names).toContain("read");
      expect(names).toContain("write");
      expect(names).toContain("edit");
      expect(names).toHaveLength(3);
    });

    it("skips tools that already exist", () => {
      const names = getMemoryToolNames(new Set(["read", "edit"]));
      expect(names).toEqual(["write"]);
    });

    it("returns empty when all memory tools already exist", () => {
      const names = getMemoryToolNames(new Set(["read", "write", "edit"]));
      expect(names).toHaveLength(0);
    });
  });

  describe("getReadOnlyMemoryToolNames", () => {
    it("returns only read when missing", () => {
      const names = getReadOnlyMemoryToolNames(new Set());
      expect(names).toEqual(["read"]);
    });

    it("returns empty when read already exists", () => {
      const names = getReadOnlyMemoryToolNames(new Set(["read"]));
      expect(names).toHaveLength(0);
    });
  });

  describe("BUILTIN_TOOL_NAMES", () => {
    // BUILTIN_TOOL_NAMES is derived dynamically from pi's tool factories
    // (createCodingTools + createReadOnlyTools). This guards against pi-mono
    // dropping/renaming a built-in: the set must still contain at least these
    // 7. It's a superset check ("at least") — pi adding a new built-in is fine
    // and won't fail this test.
    const EXPECTED = ["read", "bash", "edit", "write", "grep", "find", "ls"];

    it("contains at least the 7 known built-ins", () => {
      for (const name of EXPECTED) {
        expect(BUILTIN_TOOL_NAMES).toContain(name);
      }
    });

    it("has no duplicate entries", () => {
      expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
    });
  });
});
