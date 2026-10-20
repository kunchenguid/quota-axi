import { statSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, resolve } from "node:path";
import { traceInput } from "./input-trace.js";
import { commandExists, execFileText } from "./process.js";
import { usableLiteralSecret } from "./secret.js";

export type OpenCodeDbCredential =
  | { status: "available"; key: string }
  | { status: "missing" | "invalid" | "error" | "skipped" };

const SQLITE_TIMEOUT_MS = 5_000;
const VALUE_PREFIX = "v";

/**
 * OpenCode 2.x's database file, resolved the way its `databasePath` does
 * (anomalyco/opencode `packages/cli/src/database-path.ts`): `OPENCODE_DB`
 * overrides the file name and is resolved against the data directory, so an
 * absolute value wins. quota-axi cannot see the build's release channel, so it
 * assumes a release build (`opencode.db`); a non-release `opencode-<channel>.db`
 * is reached through `OPENCODE_DB`. `:memory:` has no file to read.
 */
export function opencodeDatabasePath(
  authFilePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = environment.OPENCODE_DB;
  if (override === ":memory:") return override;
  return resolve(dirname(authFilePath), override || "opencode.db");
}

/**
 * The credential OpenCode itself would select for `integrationId`: the row
 * ordered by `active` desc, `time_created` desc, `id` desc (its
 * `Credential.create` selection order). The database is read through
 * `sqlite3 -readonly` and only a `Credential.Key` value (`{type: "key", key}`)
 * with a literal key is accepted; OAuth and external values are `invalid`.
 * Without `sqlite3` an existing database is `skipped`, never a sign-out.
 */
export async function readOpenCodeDbCredential(
  databasePath: string,
  integrationId: string,
): Promise<OpenCodeDbCredential> {
  if (databasePath === ":memory:") return { status: "missing" };
  // A WAL-mode commit lands in the `-wal` file and leaves the main file's
  // metadata alone, so a fresh login is only visible through both.
  for (const suffix of ["", "-wal", "-shm"]) traceInput(databasePath + suffix);
  try {
    if (statSync(databasePath, { throwIfNoEntry: false }) === undefined) {
      return { status: "missing" };
    }
  } catch {
    return { status: "error" };
  }
  if (!(await commandExists("sqlite3"))) return { status: "skipped" };
  try {
    const output = await execFileText(
      "sqlite3",
      [
        "-readonly",
        // An empty init file replaces ~/.sqliterc, so a user's `.mode json` or
        // `.headers on` cannot change the output shape.
        "-init",
        devNull,
        "-list",
        "-noheader",
        databasePath,
        `select '${VALUE_PREFIX}' || value from credential where integration_id = '${integrationId.replace(/'/g, "''")}' order by active desc, time_created desc, id desc limit 1;`,
      ],
      SQLITE_TIMEOUT_MS,
    );
    const line = output.replace(/\r?\n$/, "");
    if (!line.startsWith(VALUE_PREFIX)) return { status: "missing" };
    return classifyValue(line.slice(VALUE_PREFIX.length));
  } catch (error) {
    // A 1.x database has no `credential` table: nothing was stored here.
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return { status: "missing" };
    }
    return { status: "error" };
  }
}

function classifyValue(raw: unknown): OpenCodeDbCredential {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { status: "invalid" };
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid" };
  }
  const entry = value as Record<string, unknown>;
  const key = entry.type === "key" ? usableLiteralSecret(entry.key) : undefined;
  return key ? { status: "available", key } : { status: "invalid" };
}
