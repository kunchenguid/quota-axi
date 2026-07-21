import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKimiAdapter } from "../../../../dist/src/providers/kimi.js";

const cases = [
  { status: 503, contentType: "application/json", expected: "provider_unavailable" },
  { status: 200, contentType: "text/plain", expected: "unexpected_content_type" },
];
const results = [];

for (const testCase of cases) {
  results.push(await exercise(testCase));
}

const transcript = [
  "$ node reproduce-loopback-socket-close.mjs",
  JSON.stringify(results, null, 2),
  "externalNetworkContact: false (the injected transport rewrote the fixed Kimi URL to 127.0.0.1)",
  "result: PASS",
  "",
].join("\n");
writeFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "loopback-socket-close.txt"),
  transcript,
  { mode: 0o600 },
);
process.stdout.write(transcript);

async function exercise({ status, contentType, expected }) {
  const responseClosed = deferred();
  const socketClosed = deferred();
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.once("close", responseClosed.resolve);
    response.socket?.once("close", socketClosed.resolve);
    response.writeHead(status, { "content-type": contentType });
    response.write("synthetic streaming response");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const loopbackUrl = `http://127.0.0.1:${address.port}/usage`;
    let requestContract;
    const adapter = createKimiAdapter({
      broker: {
        resolve: async () => ({ status: "available", apiKey: "synthetic-loopback-key" }),
        inspect: async () => "available",
      },
      cliCredentialSource: {
        resolve: async () => ({ status: "missing" }),
        inspect: async () => "missing",
      },
      fetch: async (input, init) => {
        requestContract = {
          url: String(input),
          method: init?.method,
          redirect: init?.redirect,
          credentials: init?.credentials,
        };
        assert(
          requestContract.url === "https://api.kimi.com/coding/v1/usages",
          "fixed Kimi request URL changed",
        );
        return globalThis.fetch(loopbackUrl, init);
      },
      readCachedProvider: () => undefined,
      deleteCachedProvider: () => undefined,
      now: () => Date.parse("2027-02-03T04:05:06.000Z"),
      deadlineMs: 1_000,
    });

    const report = await adapter.fetchQuota({ allowKeychainPrompt: false });
    assert(report.state.error === expected, `expected ${expected}, received ${report.state.error}`);
    await settlesWithin(responseClosed.promise, "streaming response close");
    await settlesWithin(socketClosed.promise, "request socket close");

    return {
      status,
      contentType,
      mappedError: report.state.error,
      requestContract,
      streamingResponseClosed: true,
      requestSocketClosed: true,
      closeBoundMs: 2_000,
    };
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlesWithin(promise, description) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} did not settle`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
