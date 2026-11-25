import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it("blocks provider destinations before transport while preserving local fixtures", () => {
  const guard = join(import.meta.dirname, "fixtures", "offline-network.cjs");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict");
    const net = require("node:net");
    const forwarded = [];
    net.Socket.prototype.connect = function (...args) {
      forwarded.push(args);
      return this;
    };
    require(${JSON.stringify(guard)});
    const socket = new net.Socket();
    for (const args of [
      [{ host: "provider.example.invalid", port: 443 }],
      [443, "provider.example.invalid"],
      [[{ host: "provider.example.invalid", port: 443 }]],
      [{ hostname: "provider.example.invalid", port: 443 }],
    ]) {
      assert.throws(() => socket.connect(...args), /blocked an outbound socket/);
    }
    assert.equal(forwarded.length, 0);
    socket.connect({ host: "127.0.0.1", port: 1234 });
    socket.connect({ host: "::1", port: 1234 });
    socket.connect(1234, "localhost");
    socket.connect("fixture.sock");
    assert.equal(forwarded.length, 4);
    process.stdout.write("offline boundary passed");
  `,
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: { HOME: process.env.HOME, NODE_OPTIONS: "" },
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("offline boundary passed");
});
