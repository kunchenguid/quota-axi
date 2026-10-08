import { describe, expect, it } from "vitest";
import {
  keyCredentialFailure,
  preferCredentialFailure,
} from "../../src/providers/env-pi-credential.js";

const absent = keyCredentialFailure("deepseek", {
  status: "missing",
  source: "env:DEEPSEEK_API_KEY",
});
const invalid = keyCredentialFailure("deepseek", {
  status: "invalid",
  source: "pi:deepseek",
});
const unresolved = keyCredentialFailure("deepseek", {
  status: "error",
  source: "pi:deepseek",
});

describe("shared env-plus-Pi credential failure ranking", () => {
  it("ranks a present-but-unusable credential above an earlier plain absence", () => {
    expect(preferCredentialFailure(absent, invalid)).toEqual(invalid);
    expect(preferCredentialFailure(absent, unresolved)).toEqual(unresolved);
  });

  it("keeps a present failure when a plain absence follows it", () => {
    expect(preferCredentialFailure(invalid, absent)).toEqual(invalid);
    expect(preferCredentialFailure(unresolved, absent)).toEqual(unresolved);
  });

  it("ranks a credential-resolution error above an unusable credential", () => {
    expect(preferCredentialFailure(invalid, unresolved)).toEqual(unresolved);
    expect(preferCredentialFailure(unresolved, invalid)).toEqual(unresolved);
    expect(preferCredentialFailure(unresolved, absent)).toEqual(unresolved);
  });

  it("takes the first failure when nothing outranks it yet", () => {
    expect(preferCredentialFailure(undefined, absent)).toEqual(absent);
    expect(preferCredentialFailure(undefined, invalid)).toEqual(invalid);
    expect(preferCredentialFailure(absent, absent)).toEqual(absent);
  });
});
