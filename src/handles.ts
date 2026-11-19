/** Cap the handle length when an agent type or supplied name is long. */
const MAX_HANDLE_LENGTH = 64;

/** Handles that must not be assigned to subagents. */
const RESERVED_HANDLES: ReadonlySet<string> = new Set(["main"]);

/** Lowercase slug of an agent type or name using letters, digits, underscores, and hyphens. */
export function handleBase(type: string): string {
  const slug = type.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE_LENGTH)
    // The slice can land mid-run and leave the trailing hyphen back.
    .replace(/-+$/, "");
  return slug || "agent";
}

/**
 * `base`, else `base-2`, `base-3`, … — the first form that is neither `taken`
 * nor reserved. Callers pass one shared `taken` set covering type-derived
 * handles and model-supplied aliases alike, so the two can never collide.
 */
export function assignHandle(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  let n = 1;
  while (taken.has(candidate) || RESERVED_HANDLES.has(candidate)) {
    n++;
    candidate = `${base}-${n}`;
  }
  return candidate;
}
