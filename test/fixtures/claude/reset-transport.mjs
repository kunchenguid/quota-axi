// Synthetic transport for the built public CLI. No real request can escape.
import { appendFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

net.Socket.prototype.connect = function () {
  throw new Error("Network is forbidden in the Claude reset fixture");
};
syncBuiltinESMExports();

const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : ["2026-11-17T09:00:00.000Z"]));
  }
  static now() {
    return NativeDate.parse("2026-11-17T09:00:00.000Z");
  }
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const bearer = new Headers(init.headers).get("authorization");
  appendFileSync(
    process.env.RESET_REQUEST_LOG,
    JSON.stringify({ method, url }) + "\n",
  );
  if (
    method !== "GET" ||
    !["Bearer fixture-only", "Bearer fixture-sibling"].includes(bearer)
  )
    throw new Error("Unexpected method or fixture bearer");
  if (
    url ===
    "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"
  ) {
    if (new Headers(init.headers).get("anthropic-beta") !== "oauth-2025-04-20")
      throw new Error("OAuth beta header changed");
    return Response.json(
      JSON.parse(
        readFileSync(
          bearer === "Bearer fixture-sibling"
            ? process.env.RESET_SIBLING_USAGE_FIXTURE
            : process.env.RESET_USAGE_FIXTURE,
          "utf8",
        ),
      ),
    );
  }
  if (url === "https://api.anthropic.com/api/oauth/profile")
    return Response.json({
      account: {
        uuid:
          bearer === "Bearer fixture-sibling"
            ? "fixture-account-sibling"
            : "fixture-account",
      },
      organization: { uuid: "fixture-org" },
    });
  throw new Error("Unexpected request: " + method + " " + url);
};
