import { describe, expect, it } from "vitest";
import {
  fetchQuotaWithRuntime,
  portsFromLsof,
  processInfosFromPs,
  type AgyProbeRuntime,
} from "../../src/providers/agy.js";

describe("Antigravity quota discovery", () => {
  it("parses Antigravity processes and listening ports without matching prompt text", () => {
    const processes = processInfosFromPs(`
      101 /Users/test/.local/bin/agy
      102 /Applications/Google Antigravity.app/Contents/Resources/bin/language-server --csrf_token token --extension_server_port 64123
      103 codex --prompt "run quota-axi --provider agy"
    `);

    expect(processes).toMatchObject([
      { pid: 101, source: "agy" },
      {
        pid: 102,
        source: "app",
        csrfToken: "token",
        extensionPort: 64123,
      },
    ]);
    expect(
      portsFromLsof(`
COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
agy 101 test 8u IPv4 0x1 0t0 TCP 127.0.0.1:64440 (LISTEN)
agy 101 test 9u IPv4 0x2 0t0 TCP 127.0.0.1:64441 (LISTEN)
`),
    ).toEqual([64440, 64441]);
  });

  it("reports unavailable without trying HTTP when Antigravity is not running", async () => {
    const result = await fetchQuotaWithRuntime(runtimeWith({ ps: "", lsof: "" }));

    expect(result.state.status).toBe("unavailable");
    expect(result.state.error).toBe("Antigravity/agy is not running");
  });

  it("does not launch agy or any provider process", async () => {
    const commands: string[] = [];
    const runtime = runtimeWith({
      ps: "",
      lsof: "",
      onExec(command) {
        commands.push(command);
      },
    });

    await fetchQuotaWithRuntime(runtime);

    expect(commands).toEqual(["ps"]);
    expect(commands).not.toContain("agy");
  });
});

function runtimeWith(options: {
  ps?: string;
  lsof?: string;
  onExec?: (command: string) => void;
}): AgyProbeRuntime {
  return {
    async execFileText(command) {
      options.onExec?.(command);
      if (command === "ps") return options.ps ?? "";
      if (command === "lsof") return options.lsof ?? "";
      throw new Error(`unexpected command: ${command}`);
    },
  };
}
