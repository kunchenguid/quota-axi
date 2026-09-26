import { describe, expect, it } from "vitest";
import { classifyPiAuthEntry } from "../../src/lib/pi-auth-store.js";

/**
 * The one owner of "absent versus present-but-broken" for every Pi auth
 * reader. The distinction is load-bearing: `missing` means the machine simply
 * has no such source and must stay silent, while any other non-usable result
 * is a broken store that a working sibling supersedes rather than hides, so
 * it has to reach the report as a degraded source.
 */
describe("classifyPiAuthEntry", () => {
  const provider = "xai";

  it("treats an absent provider property as missing, not broken", () => {
    expect(classifyPiAuthEntry({}, provider)).toEqual({ status: "missing" });
    expect(classifyPiAuthEntry({ "openai-codex": {} }, provider)).toEqual({
      status: "missing",
    });
  });

  it("hands back a present object entry for the reader to interpret", () => {
    const entry = { type: "oauth", access: "token" };

    expect(classifyPiAuthEntry({ [provider]: entry }, provider)).toEqual({
      status: "present",
      entry,
    });
  });

  it("reports an empty entry as present so the reader rejects it, not as missing", () => {
    // `{"xai": {}}` is one of the two cases that once read as absence, which
    // left a broken Pi store invisible behind a healthy sibling. Handing it
    // back as `present` is what lets the reader call it invalid.
    expect(classifyPiAuthEntry({ [provider]: {} }, provider)).toEqual({
      status: "present",
      entry: {},
    });
  });

  it.each([
    ["null entry", null],
    ["array entry", []],
    ["string entry", "token"],
    ["number entry", 7],
    ["boolean entry", true],
  ])("classifies a present %s as invalid, not missing", (_label, entry) => {
    expect(classifyPiAuthEntry({ [provider]: entry }, provider)).toEqual({
      status: "invalid",
    });
  });

  it.each([
    ["null store", null],
    ["array store", []],
    ["string store", "not-a-store"],
    ["number store", 0],
  ])("classifies a %s as invalid", (_label, parsed) => {
    expect(classifyPiAuthEntry(parsed, provider)).toEqual({
      status: "invalid",
    });
  });

  it("reads only its own provider's property", () => {
    const store = { xai: { type: "oauth" }, "kimi-coding": null };

    expect(classifyPiAuthEntry(store, "xai")).toEqual({
      status: "present",
      entry: { type: "oauth" },
    });
    expect(classifyPiAuthEntry(store, "kimi-coding")).toEqual({
      status: "invalid",
    });
    expect(classifyPiAuthEntry(store, "openai-codex")).toEqual({
      status: "missing",
    });
  });

  it("does not mistake an inherited property for a stored entry", () => {
    // `Object.hasOwn`, not `in`: a prototype-chain hit is not a credential.
    const store = Object.create({ xai: { type: "oauth" } }) as object;

    expect(classifyPiAuthEntry(store, provider)).toEqual({ status: "missing" });
  });

  it("treats an own property explicitly set to undefined as present", () => {
    expect(classifyPiAuthEntry({ [provider]: undefined }, provider)).toEqual({
      status: "invalid",
    });
  });
});
