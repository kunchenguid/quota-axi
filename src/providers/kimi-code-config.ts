import { basename, join } from "node:path";

/**
 * Kimi Code stores one credential per environment, and the environment decides
 * both which file holds the token and which host that token is good for.
 *
 * The Kimi Code CLI derives its OAuth slot from the `{oauthHost, baseUrl}` pair
 * it logged in against: the mainland-China defaults keep the unsuffixed
 * `kimi-code` slot, and every other environment gets a slot suffixed with a
 * hash of that pair. It persists the resulting reference in
 * `<home>/config.toml`, so the reference - not a directory scan - is what says
 * which slot is current.
 *
 * Reading that reference is what lets quota-axi see a global (`.ai`) login at
 * all. Pairing it with the same table's `base_url` is what keeps the token and
 * the endpoint in one bundle: this module never returns a credential path
 * without the base URL resolved from the same source, so no reading can send
 * one region's token to another region's host.
 */

/** `[providers."managed:kimi-code"]`, the table Kimi Code writes for itself. */
const MANAGED_PROVIDER_TABLE = ["providers", "managed:kimi-code"] as const;
const OAUTH_TABLE = [...MANAGED_PROVIDER_TABLE, "oauth"] as const;

const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
export const DEFAULT_KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_KEY = "oauth/kimi-code";
const DEFAULT_CREDENTIAL_NAME = "kimi-code";

/**
 * Kimi Code's own two deployments, transcribed from the region profile table
 * the CLI ships. An environment is accepted only when the endpoints it records
 * belong to one of these profiles, and the request always goes to the profile's
 * own base URL, so a `config.toml` cannot point quota-axi's bearer request at an
 * origin Kimi does not serve.
 */
const KIMI_REGION_PROFILES = [
  { oauthHost: DEFAULT_OAUTH_HOST, baseUrl: DEFAULT_KIMI_CODE_BASE_URL },
  {
    oauthHost: "https://auth.kimi.ai",
    baseUrl: "https://api.kimi.ai/coding/v1",
  },
] as const;

/** The keys read out of the config; every other key is parsed past, never kept. */
const PROVIDER_KEYS = ["base_url", "baseUrl"] as const;
const OAUTH_KEYS = ["storage", "key", "oauth_host", "oauthHost"] as const;

export type KimiCodeEnvironment =
  | { status: "resolved"; credentialFileName: string; baseUrl: string }
  /** The token lives in an OS keyring, which quota-axi does not read. */
  | { status: "unsupported_storage" }
  /** The configured endpoints are not one of Kimi Code's own deployments. */
  | { status: "unrecognized_region" }
  /** `config.toml` named a slot this reader must not open. */
  | { status: "invalid_config" };

/**
 * The environment a `config.toml` describes, or the default slot when it names
 * no OAuth reference. An absent file is the default too: a mainland-China login
 * persists the default key, so "no reference" and "the default reference" are
 * the same environment, and today's behaviour is preserved exactly.
 *
 * A document this reader cannot walk to the end resolves from whatever it did
 * read before stopping, which for a file naming no reference before that point
 * is the default slot on the default deployment. Refusing to read the
 * credential over a construct like an unsupported TOML form would take a
 * working mainland-China reading away, and the default slot is the one the CLI
 * writes for the default deployment, so it is never a mismatched pair.
 */
export function resolveKimiCodeEnvironment(
  configText: string | undefined,
): KimiCodeEnvironment {
  if (configText === undefined) return defaultEnvironment();

  const { provider, oauth } = scanConfig(configText);
  if (oauth === undefined) return defaultEnvironment(provider?.base_url);

  const storage = oauth.storage ?? "file";
  if (storage !== "file") return { status: "unsupported_storage" };

  const credentialFileName = credentialFileNameFor(
    oauth.key ?? DEFAULT_OAUTH_KEY,
  );
  if (credentialFileName === undefined) return { status: "invalid_config" };

  const region = regionFor(provider?.base_url, oauth.oauth_host);
  if (region === undefined) return { status: "unrecognized_region" };
  /**
   * The unsuffixed slot is the one Kimi Code derives for the default
   * deployment, so a configuration that names it alongside another deployment
   * describes no environment the CLI writes. Reading it would send that
   * deployment's token to the other one's host.
   */
  if (
    credentialFileName === DEFAULT_CREDENTIAL_NAME &&
    region.baseUrl !== DEFAULT_KIMI_CODE_BASE_URL
  ) {
    return { status: "unrecognized_region" };
  }

  return { status: "resolved", credentialFileName, baseUrl: region.baseUrl };
}

/**
 * The deployment a configuration names, matched on whichever of the two
 * endpoint fields it records. Kimi Code writes both, but a file that carries
 * only one still identifies a deployment unambiguously, and the resolved base
 * URL is taken from the profile rather than from the file either way - so a
 * half-written record stays inside the same two-deployment allowlist instead of
 * costing the user a reading.
 */
function regionFor(
  baseUrl: string | undefined,
  oauthHost: string | undefined,
): (typeof KIMI_REGION_PROFILES)[number] | undefined {
  if (baseUrl === undefined && oauthHost === undefined) {
    return KIMI_REGION_PROFILES[0];
  }
  const wantedBaseUrl =
    baseUrl === undefined ? undefined : normalizeUrl(baseUrl);
  const wantedOauthHost =
    oauthHost === undefined ? undefined : normalizeUrl(oauthHost);
  return KIMI_REGION_PROFILES.find(
    (profile) =>
      (wantedBaseUrl === undefined ||
        normalizeUrl(profile.baseUrl) === wantedBaseUrl) &&
      (wantedOauthHost === undefined ||
        normalizeUrl(profile.oauthHost) === wantedOauthHost),
  );
}

function defaultEnvironment(baseUrl?: string): KimiCodeEnvironment {
  if (
    baseUrl !== undefined &&
    normalizeUrl(baseUrl) !== DEFAULT_KIMI_CODE_BASE_URL
  ) {
    return { status: "unrecognized_region" };
  }
  return {
    status: "resolved",
    credentialFileName: DEFAULT_CREDENTIAL_NAME,
    baseUrl: DEFAULT_KIMI_CODE_BASE_URL,
  };
}

/** The usage endpoint for a resolved environment's base URL. */
export function kimiUsageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/usages`;
}

export function kimiCredentialPath(
  codeHome: string,
  credentialFileName: string,
): string {
  return join(codeHome, "credentials", `${credentialFileName}.json`);
}

/**
 * Kimi Code's slot-key-to-file-name rule, with its storage layer's own
 * containment check applied after it: the resulting name must be a bare file
 * name and must not start with a dot, so a configured key can never walk out of
 * the credentials directory.
 */
function credentialFileNameFor(key: string): string | undefined {
  const name =
    key === DEFAULT_CREDENTIAL_NAME || key === DEFAULT_OAUTH_KEY
      ? DEFAULT_CREDENTIAL_NAME
      : key.startsWith("oauth/") && key.length > "oauth/".length
        ? key.slice("oauth/".length)
        : !key.includes("/") && !key.startsWith(".")
          ? key
          : undefined;
  if (name === undefined || name.length === 0) return undefined;
  return basename(name) === name && !name.startsWith(".") ? name : undefined;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

type ScannedTable = Record<string, string>;
type ScannedConfig = {
  provider?: ScannedTable;
  oauth?: ScannedTable;
};

/**
 * A deliberately narrow TOML reader: it walks the document well enough to know
 * which table each key belongs to, and keeps only the handful of keys named
 * above. The provider's literal API key sits in the very table this reads, so
 * nothing outside that
 * whitelist is retained past the value that had to be stepped over to find the
 * next key. A construct it cannot walk ends the scan where it stands and
 * returns what was already read, so a form outside this reader's coverage
 * cannot suppress a reference it had already seen, nor cost a document that
 * names none the default reading it has always had.
 */
function scanConfig(text: string): ScannedConfig {
  const scanned: ScannedConfig = {};
  let table: string[] = [];
  let index = 0;

  const atEnd = (): boolean => index >= text.length;

  const skipIgnorable = (): void => {
    while (!atEnd()) {
      const char = text[index];
      if (char === " " || char === "\t" || char === "\r" || char === "\n") {
        index += 1;
      } else if (char === "#") {
        while (!atEnd() && text[index] !== "\n") index += 1;
      } else {
        return;
      }
    }
  };

  try {
    while (true) {
      skipIgnorable();
      if (atEnd()) break;

      if (text[index] === "[") {
        table = readTableHeader();
        continue;
      }

      readKeyValue(table);
    }
  } catch {
    return scanned;
  }

  return scanned;

  function tableFor(segments: string[]): "provider" | "oauth" | undefined {
    if (sameSegments(segments, OAUTH_TABLE)) return "oauth";
    if (sameSegments(segments, MANAGED_PROVIDER_TABLE)) return "provider";
    return undefined;
  }

  /**
   * One `key = value`, where the key may be a dotted path. TOML scopes such a
   * path under the enclosing table, so the owning table is the prefix and only
   * the last segment is the key - which is also how an `oauth.key` line under
   * the managed provider's own table reaches the OAuth table.
   */
  function readKeyValue(prefix: string[]): void {
    const path = readKeyPath();
    skipInlineSpace();
    if (text[index] !== "=") throw new Error("expected '='");
    index += 1;
    skipInlineSpace();
    const key = path[path.length - 1];
    const owner = [...prefix, ...path.slice(0, -1)];
    const value = readValue([...owner, key]);
    if (value === undefined) return;

    const target = tableFor(owner);
    if (target === undefined) return;
    const allowed =
      target === "provider"
        ? (PROVIDER_KEYS as readonly string[])
        : (OAUTH_KEYS as readonly string[]);
    if (!allowed.includes(key)) return;
    const bucket = (scanned[target] ??= {});
    bucket[canonicalKey(key)] = value;
  }

  function readKeyPath(): string[] {
    const segments: string[] = [];
    while (true) {
      skipInlineSpace();
      segments.push(readKey());
      skipInlineSpace();
      if (text[index] === ".") {
        index += 1;
        continue;
      }
      break;
    }
    return segments;
  }

  function readTableHeader(): string[] {
    const arrayOfTables = text.startsWith("[[", index);
    index += arrayOfTables ? 2 : 1;
    const segments = readKeyPath();
    const closing = arrayOfTables ? "]]" : "]";
    if (!text.startsWith(closing, index)) throw new Error("unterminated table");
    index += closing.length;
    return segments;
  }

  function readKey(): string {
    const char = text[index];
    if (char === '"' || char === "'") return readString();
    const start = index;
    while (!atEnd() && /[A-Za-z0-9_-]/.test(text[index])) index += 1;
    if (index === start) throw new Error("expected a key");
    return text.slice(start, index);
  }

  /**
   * Consumes a value entirely; returns it only when it is a plain string. An
   * inline table is a table like any other, so its own keys are scanned under
   * the path that names it rather than stepped over - a reference written
   * inline carries exactly the same weight as one written as a table header.
   */
  function readValue(path: string[]): string | undefined {
    const char = text[index];
    if (char === '"' || char === "'") return readString();
    if (char === "[") {
      readCollection("[", "]");
      return undefined;
    }
    if (char === "{") {
      readInlineTable(path);
      return undefined;
    }
    const start = index;
    while (!atEnd() && !"\n#,]}".includes(text[index])) index += 1;
    if (index === start) throw new Error("expected a value");
    return text.slice(start, index).trim();
  }

  function readInlineTable(prefix: string[]): void {
    index += 1;
    while (true) {
      skipIgnorable();
      if (atEnd()) throw new Error("unterminated inline table");
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      readKeyValue(prefix);
    }
  }

  function readCollection(open: string, close: string): void {
    let depth = 0;
    do {
      if (atEnd()) throw new Error("unterminated collection");
      const char = text[index];
      if (char === '"' || char === "'") {
        readString();
        continue;
      }
      if (char === "#") {
        while (!atEnd() && text[index] !== "\n") index += 1;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) depth -= 1;
      index += 1;
    } while (depth > 0);
  }

  function readString(): string {
    const quote = text[index];
    const triple = text.startsWith(quote.repeat(3), index);
    const delimiter = triple ? quote.repeat(3) : quote;
    index += delimiter.length;
    const literal = quote === "'";
    let value = "";
    while (true) {
      if (atEnd()) throw new Error("unterminated string");
      if (text.startsWith(delimiter, index)) {
        index += delimiter.length;
        return value;
      }
      if (!literal && text[index] === "\\") {
        value += unescape();
        continue;
      }
      value += text[index];
      index += 1;
    }
  }

  function unescape(): string {
    index += 1;
    const char = text[index];
    index += 1;
    const simple: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (char in simple) return simple[char];
    if (char === "u" || char === "U") {
      const width = char === "u" ? 4 : 8;
      const digits = text.slice(index, index + width);
      if (!/^[0-9A-Fa-f]+$/.test(digits) || digits.length !== width) {
        throw new Error("bad escape");
      }
      index += width;
      return String.fromCodePoint(Number.parseInt(digits, 16));
    }
    if (char === "\n" || char === " " || char === "\r") {
      while (!atEnd() && /\s/.test(text[index])) index += 1;
      return "";
    }
    throw new Error("bad escape");
  }

  function skipInlineSpace(): void {
    while (!atEnd() && (text[index] === " " || text[index] === "\t"))
      index += 1;
  }
}

function canonicalKey(key: string): string {
  return key === "baseUrl"
    ? "base_url"
    : key === "oauthHost"
      ? "oauth_host"
      : key;
}

function sameSegments(left: string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, position) => segment === right[position])
  );
}
