import { describe, expect, it } from "vitest";
import { assignHandle, handleBase } from "../src/handles.js";

describe("handleBase", () => {
  it("lowercases so the handle matches how it is typed", () => {
    expect(handleBase("Explore")).toBe("explore");
  });

  it("keeps a hyphenated type as-is", () => {
    expect(handleBase("general-purpose")).toBe("general-purpose");
  });

  it("reduces anything outside [\\w-] to hyphens, without leaving edge hyphens", () => {
    expect(handleBase("Code Review!")).toBe("code-review");
    expect(handleBase("  spaced  out  ")).toBe("spaced-out");
  });

  it("always produces something typeable", () => {
    // A type made entirely of stripped characters would otherwise slug to "".
    expect(handleBase("!!!")).toBe("agent");
    expect(handleBase("")).toBe("agent");
  });

  it("caps a long name so one agent can't own an unreadable row", () => {
    const slug = handleBase("x".repeat(200));
    expect(slug).toHaveLength(64);
  });

  it("never leaves a trailing hyphen the cap sliced into", () => {
    // 63 chars, then a hyphen run: a naive slice(0, 64) keeps that hyphen.
    expect(handleBase(`${"x".repeat(63)}   tail`).endsWith("-")).toBe(false);
  });

  it("produces only letters, digits, underscores, and hyphens", () => {
    for (const type of ["Explore", "general-purpose", "Code Review!", "!!!", "デバッグ"]) {
      expect(handleBase(type)).toMatch(/^[a-z0-9_-]+$/);
    }
  });
});

describe("assignHandle", () => {
  it("takes the plain base when it is free", () => {
    expect(assignHandle("explore", new Set())).toBe("explore");
  });

  it("numbers from 2 on the first collision", () => {
    expect(assignHandle("explore", new Set(["explore"]))).toBe("explore-2");
  });

  it("keeps counting past every taken form", () => {
    expect(assignHandle("explore", new Set(["explore", "explore-2"]))).toBe("explore-3");
  });

  it("never hands out the reserved main handle", () => {
    expect(assignHandle("main", new Set())).toBe("main-2");
  });

  it("reuses the first available suffix without shadowing a live handle", () => {
    // explore-2 finished and was evicted; reusing it is fine, but explore-3
    // is still running and must not be shadowed.
    expect(assignHandle("explore", new Set(["explore", "explore-3"]))).toBe("explore-2");
  });
});
