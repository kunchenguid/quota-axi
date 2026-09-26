import { describe, expect, it, vi } from "vitest";
import { readWindowsGenericPassword } from "../src/lib/windows-credential.js";

// Explicit synthetic namespace: these are not asserted Copilot item selectors.
const binding = {
  target: "quota-axi-synthetic-target",
  username: "synthetic-user",
};
const secret = "gho_synthetic_fixture";
const systemRoot = "C:\\Windows";

describe("bounded Windows generic-password transport", () => {
  it("returns a password only in memory using a bounded captured child", async () => {
    const run = vi.fn(async () => `ok\n${secret}`);
    expect(
      await readWindowsGenericPassword(binding, { run, systemRoot }),
    ).toEqual({
      status: "resolved",
      value: secret,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, timeout, maxBuffer] = run.mock
      .calls[0] as unknown as [string, string[], number, number];
    expect(command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(timeout).toBe(10_000);
    expect(maxBuffer).toBe(16 * 1024);
    expect(JSON.stringify(run.mock.calls)).not.toContain(secret);
  });

  it.each([
    "credential_not_found",
    "credential_logon_session_unavailable",
    "credential_access_denied",
    "credential_binding_mismatch",
    "credential_format_unsupported",
  ])("preserves the sanitized native outcome %s", async (reason) => {
    const run = vi.fn(async () => reason);
    expect(
      await readWindowsGenericPassword(binding, { run, systemRoot }),
    ).toEqual({
      status: "unavailable",
      reason,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      Object.assign(new Error(secret), { stdout: secret, stderr: secret }),
      "credential_read_failed",
    ],
    [{ code: "ENOENT", stdout: secret }, "credential_read_failed"],
    [{ killed: true, stdout: secret }, "credential_read_timeout"],
    [{ signal: "SIGTERM", stderr: secret }, "credential_read_timeout"],
    [
      Object.assign(new Error(secret), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        stdout: secret,
      }),
      "credential_format_unsupported",
    ],
  ])("never forwards subprocess errors or retries", async (error, reason) => {
    const run = vi.fn().mockRejectedValue(error);
    const result = await readWindowsGenericPassword(binding, {
      run,
      systemRoot,
    });
    expect(result).toEqual({ status: "unavailable", reason });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    "ok\n",
    "ok\n" + secret + "\n",
    "ok\n" + secret + "\0",
    "ok\né",
    "ok\n" + "x".repeat(1281),
  ])("rejects malformed bridge values", async (output) => {
    const run = vi.fn(async () => output);
    const result = await readWindowsGenericPassword(binding, {
      run,
      systemRoot,
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "credential_format_unsupported",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([secret, `error: ${secret}`, `credential_not_found\n${secret}`, ""])(
    "withholds unrecognized protocol output",
    async (output) => {
      const run = vi.fn(async () => output);
      const result = await readWindowsGenericPassword(binding, {
        run,
        systemRoot,
      });
      expect(result).toEqual({
        status: "unavailable",
        reason: "credential_read_failed",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it.each([
    { target: "", username: "user" },
    { target: "target", username: "" },
    { target: "target\0other", username: "user" },
    { target: "target", username: "user\nother" },
    { target: "x".repeat(513), username: "user" },
  ])("refuses invalid selectors before starting a child", async (selection) => {
    const run = vi.fn();
    expect(
      await readWindowsGenericPassword(selection, { run, systemRoot }),
    ).toEqual({
      status: "unavailable",
      reason: "credential_binding_mismatch",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not search PATH for PowerShell when the system root is unconfirmed", async () => {
    const run = vi.fn();
    expect(
      await readWindowsGenericPassword(binding, {
        run,
        systemRoot: "relative",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "credential_read_failed",
    });
    expect(run).not.toHaveBeenCalled();
  });
});
