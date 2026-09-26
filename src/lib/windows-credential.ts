import { win32 } from "node:path";
import { execFileText } from "./process.js";

export type WindowsCredentialResult =
  | { status: "resolved"; value: string }
  | {
      status: "unavailable";
      reason:
        | "credential_not_found"
        | "credential_logon_session_unavailable"
        | "credential_access_denied"
        | "credential_binding_mismatch"
        | "credential_format_unsupported"
        | "credential_read_timeout"
        | "credential_read_failed";
    };

const OUTPUT_LIMIT = 16 * 1024;
const TIMEOUT_MS = 10_000;
const REASONS = new Set([
  "credential_not_found",
  "credential_logon_session_unavailable",
  "credential_access_denied",
  "credential_binding_mismatch",
  "credential_format_unsupported",
]);

/**
 * Read one explicitly bound generic UTF-16 password in the caller's Windows
 * logon session. This helper neither discovers nor guesses vendor bindings.
 * The caller owns consent and must establish target/user/encoding beforehand.
 * Child stdout is an in-memory pipe only; never expose a subprocess error,
 * which can carry that pipe's secret contents.
 */
export async function readWindowsGenericPassword(
  binding: { target: string; username: string },
  dependencies: {
    run?: typeof execFileText;
    systemRoot?: string;
  } = {},
): Promise<WindowsCredentialResult> {
  const unavailable = (
    reason: Extract<
      WindowsCredentialResult,
      { status: "unavailable" }
    >["reason"],
  ): WindowsCredentialResult => ({ status: "unavailable", reason });
  if (
    !binding.target ||
    !binding.username ||
    binding.target.length > 512 ||
    binding.username.length > 512 ||
    [...(binding.target + binding.username)].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    return unavailable("credential_binding_mismatch");
  }
  const root = dependencies.systemRoot ?? process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root))
    return unavailable("credential_read_failed");
  const script = windowsPasswordScript(binding);
  let output: string;
  try {
    output = await (dependencies.run ?? execFileText)(
      win32.join(
        root,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      TIMEOUT_MS,
      OUTPUT_LIMIT,
    );
  } catch (error) {
    const failure = error as {
      code?: unknown;
      killed?: boolean;
      signal?: unknown;
    } | null;
    if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return unavailable("credential_format_unsupported");
    return unavailable(
      failure?.killed || failure?.signal
        ? "credential_read_timeout"
        : "credential_read_failed",
    );
  }
  // Only the fixed protocol can leave this boundary. In particular, diagnostic
  // text from PowerShell, Add-Type, or a malformed bridge is never forwarded.
  if (output.startsWith("ok\n")) {
    const value = output.slice(3);
    if (
      value.length > 0 &&
      value.length <= 1280 &&
      /^[\x21-\x7e]+$/.test(value)
    )
      return { status: "resolved", value };
    return unavailable("credential_format_unsupported");
  }
  if (REASONS.has(output))
    return unavailable(
      output as Extract<
        WindowsCredentialResult,
        { status: "unavailable" }
      >["reason"],
    );
  return unavailable("credential_read_failed");
}

function windowsPasswordScript(binding: {
  target: string;
  username: string;
}): string {
  // Base64 is just quoting for non-secret selectors, not secret transport.
  const encode = (value: string) =>
    Buffer.from(value, "utf8").toString("base64");
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class QuotaAxiCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint BlobSize;
    public IntPtr Blob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);
  public static string Read(string target, string username) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) {
      switch (Marshal.GetLastWin32Error()) {
        case 1168: return "credential_not_found";
        case 1312: return "credential_logon_session_unavailable";
        case 5: return "credential_access_denied";
        default: return "credential_read_failed";
      }
    }
    byte[] bytes = null;
    try {
      Credential item = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (item.Type != 1 || !String.Equals(item.TargetName, target, StringComparison.Ordinal) ||
          !String.Equals(item.UserName, username, StringComparison.Ordinal))
        return "credential_binding_mismatch";
      if (item.Blob == IntPtr.Zero || item.BlobSize == 0 || item.BlobSize > 2560 || item.BlobSize % 2 != 0)
        return "credential_format_unsupported";
      bytes = new byte[(int)item.BlobSize];
      Marshal.Copy(item.Blob, bytes, 0, bytes.Length);
      string value = new UnicodeEncoding(false, false, true).GetString(bytes);
      foreach (char c in value) {
        if (c < 33 || c > 126) return "credential_format_unsupported";
      }
      return "ok\\n" + value;
    } catch {
      return "credential_format_unsupported";
    } finally {
      if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
      CredFree(pointer);
    }
  }
}
'@
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(binding.target)}'))
$username = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(binding.username)}'))
[Console]::Write([QuotaAxiCredential]::Read($target, $username))
} catch {
  [Console]::Write('credential_read_failed')
}
`;
}
