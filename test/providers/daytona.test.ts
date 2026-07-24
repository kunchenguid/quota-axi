import { afterEach, describe, expect, it } from "vitest";
import {
  buildDaytonaHeaders,
  fetchQuota,
} from "../../src/providers/daytona.js";

const original = process.env.DAYTONA_API_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.DAYTONA_API_TOKEN;
  else process.env.DAYTONA_API_TOKEN = original;
});

describe("Daytona provider", () => {
  it("sends the organization header only for JWT auth", () => {
    expect(buildDaytonaHeaders("api-key")).toEqual({
      Authorization: "Bearer api-key",
      Accept: "application/json",
    });
    expect(buildDaytonaHeaders("jwt", "org-123")).toEqual({
      Authorization: "Bearer jwt",
      Accept: "application/json",
      "X-Daytona-Organization-ID": "org-123",
    });
  });

  it("fails closed without credentials", async () => {
    delete process.env.DAYTONA_API_TOKEN;
    expect(["auth_required", "error", "fresh"]).toContain(
      (await fetchQuota({ allowKeychainPrompt: false })).state.status,
    );
  });
});
