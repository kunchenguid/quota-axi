const RESET_AT = "2026-07-31T00:00:00.000Z";

globalThis.fetch = async function quotaAxiEvidenceFetch(input, init = {}) {
  const url = String(input);
  const authorization = headerValue(init.headers, "authorization");
  if (!authorization?.startsWith("Bearer fake-")) {
    throw new Error(`evidence fetch missing fake bearer token for ${url}`);
  }

  if (
    url ===
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
  ) {
    return jsonResponse({
      billingCycleEnd: RESET_AT,
      planUsage: {
        totalPercentUsed: 42,
        autoPercentUsed: 15,
        apiPercentUsed: 8,
      },
      spendLimitUsage: {
        individualLimit: 5000,
        individualRemaining: 3750,
      },
    });
  }

  if (
    url === "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"
  ) {
    return jsonResponse({
      planInfo: {
        planName: "Cursor Pro",
        billingCycleEnd: RESET_AT,
      },
    });
  }

  if (url === "https://api.github.com/copilot_internal/user") {
    return jsonResponse({
      login: "octo-evidence",
      copilot_plan: "business",
      quota_reset_date_utc: RESET_AT,
      quota_snapshots: {
        chat: { percent_remaining: 61, quota_reset_at: RESET_AT },
        completions: { percent_remaining: 84, quota_reset_at: RESET_AT },
        premium_interactions: {
          percent_remaining: 25,
          quota_reset_at: RESET_AT,
        },
      },
    });
  }

  if (url === "https://cli-chat-proxy.grok.com/v1/billing?format=credits") {
    return jsonResponse({
      config: {
        subscription_tier: "SuperGrok",
        billingPeriodEnd: RESET_AT,
        creditUsagePercent: 33,
        onDemandCap: { val: 1000 },
        onDemandUsed: { val: 125 },
        prepaidBalance: { val: 48 },
        productUsage: [
          { product: "Grok 4 Heavy", usagePercent: 50 },
          { product: "Voice Mode", usagePercent: 10 },
        ],
      },
    });
  }

  throw new Error(`unexpected evidence fetch: ${url}`);
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  const match = entries.find(
    ([key]) => String(key).toLowerCase() === name.toLowerCase(),
  );
  return match ? String(match[1]) : undefined;
}
