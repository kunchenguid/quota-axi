import { describe, expect, it, vi } from "vitest";
import {
  keyCredentialFailure,
  preferCredentialFailure,
  requestKeyEndpoint,
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

describe("requestKeyEndpoint options", () => {
  const url = "https://key.example.invalid/usage";

  function endpoint(response: Response) {
    return vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));
  }

  it("keeps the Bearer scheme and a plain 403 rejection by default", async () => {
    const fetch = endpoint(
      new Response("<html>denied</html>", { status: 403 }),
    );

    await expect(requestKeyEndpoint(url, "key", fetch, 1_000)).rejects.toThrow(
      "provider_auth_rejected",
    );
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("Bearer key");
  });

  it("sends the requested scheme", async () => {
    const fetch = endpoint(Response.json({ ok: true }));

    await requestKeyEndpoint(url, "key", fetch, 1_000, {
      authScheme: "apikey",
    });

    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("apikey key");
  });

  it("drops revived fields while parsing", async () => {
    const payload = await requestKeyEndpoint(
      url,
      "key",
      endpoint(Response.json({ keep: 1, drop: 2 })),
      1_000,
      {
        reviver: (name, value) =>
          name === "" || name === "keep" ? value : undefined,
      },
    );

    expect(payload).toEqual({ keep: 1 });
  });

  it("counts only a JSON object body as a rejection when asked to", async () => {
    const options = { jsonRejectionOnly: true };

    await expect(
      requestKeyEndpoint(
        url,
        "key",
        endpoint(new Response("<html>denied</html>", { status: 403 })),
        1_000,
        options,
      ),
    ).rejects.toThrow("provider_error:403");
    await expect(
      requestKeyEndpoint(
        url,
        "key",
        endpoint(Response.json({ error: "denied" }, { status: 403 })),
        1_000,
        options,
      ),
    ).rejects.toThrow("provider_auth_rejected");
  });
});
