/**
 * agent-types.ts — Unified agent type registry.
 *
 * Registers custom roles from package, global, and project agent files.
 * Disabled roles are kept but excluded from spawning.
 */

import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import type { ToolDescriptionMode } from "./settings.js";
import type { AgentConfig } from "./types.js";

/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

const agents = new Map<string, AgentConfig>();

/** `fallbackSubagent` value that disables the fallback entirely (strict dispatch). */
export const NO_FALLBACK = "none";

/**
 * Agent type substituted when a caller-supplied `subagent_type` doesn't resolve
 * to exactly one enabled agent. Unset, empty and `NO_FALLBACK` all reject. Set from
 * `subagents.json` (`fallbackSubagent`).
 *
 * Module state rather than an index.ts closure because every caller-supplied
 * spawn path needs it — the Agent tool, the scheduler, and cross-extension RPC.
 */
let fallbackSubagent: string | undefined;

/** Get the configured fallback agent type. undefined = no fallback. */
export function getFallbackSubagent(): string | undefined { return fallbackSubagent; }

/** Set the configured fallback agent type. undefined = no fallback. */
export function setFallbackSubagent(v: string | undefined): void { fallbackSubagent = v; }

/** Register the loaded custom roles, including disabled definitions for display. */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();
  for (const [name, config] of userAgents) agents.set(name, config);
}

/** Get the agent config for a type (case-insensitive) from a registry. */
export function getAgentConfigIn(registry: Map<string, AgentConfig>, name: string): AgentConfig | undefined {
  const key = resolveUnambiguousKeyIn(registry, name);
  return key ? registry.get(key) : undefined;
}

/** Check if a type is valid and enabled (case-insensitive) in a registry. */
export function isValidTypeIn(registry: Map<string, AgentConfig>, type: string): boolean {
  return resolveEnabledTypeIn(registry, type) !== undefined;
}

/** Get all enabled type names in a registry (for spawning and tool descriptions). */
export function getAvailableTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/**
 * Case-insensitive resolution that refuses to guess. An exact match always wins;
 * otherwise the name must match exactly one key. Two custom roles can differ
 * only in case; picking whichever came first could silently choose a different
 * model or tool policy.
 */
function resolveUnambiguousKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = [...registry.keys()].filter(key => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The canonical key for a caller-supplied name that identifies exactly one
 * ENABLED agent, or undefined. Strict by construction: no fallback, no guessing
 * between case-variants.
 */
export function resolveEnabledTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): string | undefined {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return undefined;
  const key = resolveUnambiguousKeyIn(registry, raw);
  return key !== undefined && registry.get(key)?.enabled !== false ? key : undefined;
}

/** Resolve an enabled type without substituting another role. */
export function resolveEnabledType(requested: unknown): string | undefined {
  return resolveEnabledTypeIn(agents, requested);
}

/** Outcome of resolving a caller-supplied `subagent_type` into a spawnable type. */
export type SpawnTypeResolution =
  /** Spawn this type. `fellBackFrom` is set when it isn't what the caller asked for. */
  | { ok: true; type: string; fellBackFrom?: string }
  /** Refuse the spawn and return this message to the caller. */
  | { ok: false; message: string };

/**
 * Resolve a caller-supplied agent type against a registry, applying the
 * `fallbackSubagent` policy. The single decision point for every caller-supplied
 * spawn — the Agent tool, the scheduler, and cross-extension RPC — so a type
 * that fails here never reaches `runAgent`.
 *
 * Unknown, disabled, and case-ambiguous names are all treated the same way:
 * the caller named something that doesn't identify exactly one enabled agent.
 *
 * Pure over `registry` — callers that need fresh agent files reload before
 * calling (the Agent tool already does, per spawn). Reloading here would mean
 * importing custom-agents.ts, which imports this module.
 */
export function resolveSpawnTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): SpawnTypeResolution {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const key = resolveEnabledTypeIn(registry, raw);
  if (key !== undefined) return { ok: true, type: key };

  const configured = fallbackSubagent?.trim();
  if (configured && configured.toLowerCase() !== NO_FALLBACK) {
    const fallbackKey = resolveEnabledTypeIn(registry, configured);
    if (fallbackKey !== undefined) return { ok: true, type: fallbackKey, fellBackFrom: raw };
    return { ok: false, message: unavailableAgentTypeMessage(raw, registry, configured) };
  }
  return { ok: false, message: unavailableAgentTypeMessage(raw, registry) };
}

/** Explain a refused type without applying fallback policy. */
export function unavailableAgentTypeMessage(type: string, registry = agents, badFallback?: string): string {
  const reason = type.trim() ? `Unknown, disabled, or ambiguous agent type: "${type}".` : "No agent type given.";
  const fallback = badFallback === undefined ? "" :
    ` The configured fallbackSubagent "${badFallback}" is unknown, disabled, or ambiguous.`;
  const available = getAvailableTypesIn(registry).join(", ") || "(none)";
  return `${reason}${fallback} Available: ${available}. ` +
    "Define or enable a role in .pi/agents/<name>.md or .agents/agents/<name>.md, or install a package that provides it.";
}

/** Resolve a caller-supplied agent type against the process-wide registry. */
export function resolveSpawnType(requested: unknown): SpawnTypeResolution {
  return resolveSpawnTypeIn(agents, requested);
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveUnambiguousKeyIn(agents, name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  return getAgentConfigIn(agents, name);
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return getAvailableTypesIn(agents);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  return isValidTypeIn(agents, type);
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
  return READONLY_MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Get built-in tool names for an enabled type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  return getConfig(type)?.builtinToolNames ?? [];
}

/** Get runtime config for an enabled type, without applying any fallback. */
export function getConfig(type: string) {
  const key = resolveEnabledType(type);
  const config = key === undefined ? undefined : agents.get(key);
  if (!config) return undefined;
  return {
    displayName: config.displayName ?? config.name,
    color: config.color,
    description: config.description,
    // Omitted means all built-ins; an explicit empty list means none.
    builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
    extensions: config.extensions,
    excludeExtensions: config.excludeExtensions,
    skills: config.skills,
    promptMode: config.promptMode,
  };
}

/** Which Agent tool description the LLM sees (#91). Read when the tool is built. */
let toolDescriptionMode: ToolDescriptionMode = "full";

export function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
export function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}

/** First sentence of an agent description — for the compact type list. */
function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).replace(/\s+/g, " ").trim();
}

/**
 * The "Available agent types" list in an Agent tool description, one line per
 * name. Full lines carry the description, the model label and the tool scope;
 * compact lines the description's first sentence and the tool scope.
 */
export function formatAgentTypeList(
  names: string[],
  lookup: (name: string) => AgentConfig | undefined,
  compact: boolean,
): string {
  return names.map((name) => {
    const cfg = lookup(name);
    const tools = ` (Tools: ${formatToolsSuffix(cfg)})`;
    if (compact) return `- ${name}: ${firstSentence(cfg?.description ?? name)}${tools}`;
    const model = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    return `- ${name}: ${cfg?.description ?? name}${model}${tools}`;
  }).join("\n");
}

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools; `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  if (!cfg || cfg.enabled === false) return "unavailable";
  const tools = cfg.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg.isolated === true || cfg.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}
