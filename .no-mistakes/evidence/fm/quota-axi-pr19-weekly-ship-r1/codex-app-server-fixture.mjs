#!/usr/bin/env node

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    let result = {};

    if (request.method === "account/read") {
      result = { account: null };
    }
    if (request.method === "account/rateLimits/read") {
      result = {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 37,
            windowDurationMins: 10080,
          },
          secondary: null,
        },
        rateLimitsByLimitId: {},
      };
    }

    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }
});
