import { writeFileSync } from "node:fs";

const billingUrl = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const expectedAuth = "Bearer fixture-oidc-session-token";
const requestEvidenceUrl = new URL("./mock-grok-request.json", import.meta.url);

globalThis.fetch = async (url, init = {}) => {
  const headers = new Headers(init.headers);
  const authorization = headers.get("authorization");
  const requestEvidence = {
    url: String(url),
    authorization:
      authorization === expectedAuth
        ? "Bearer <fixture-oidc-session-token>"
        : authorization,
    accept: headers.get("accept"),
  };
  writeFileSync(requestEvidenceUrl, `${JSON.stringify(requestEvidence, null, 2)}\n`);

  if (String(url) !== billingUrl || authorization !== expectedAuth) {
    return new Response(JSON.stringify({ error: "unexpected Grok request" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-06T19:59:29.885889+00:00",
          end: "2026-07-13T19:59:29.885889+00:00"
        },
        prepaidBalance: { val: 0 }
      },
      subscriptionTier: "X Premium+"
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
};
