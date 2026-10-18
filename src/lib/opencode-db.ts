import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { traceInput } from "./input-trace.js";
import { usableLiteralSecret } from "./secret.js";

export type OpenCodeDbCredential =
  | { status: "available"; key: string }
  | { status: "missing" | "invalid" | "error" };

/** The slice of `node:sqlite` used here; the installed `@types/node` predates it. */
type SqliteModule = {
  DatabaseSync: new (
    path: string,
    options: { readOnly: boolean },
  ) => {
    prepare(sql: string): { get(...params: string[]): unknown };
    close(): void;
  };
};

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
 * `Credential.create` selection order). The database is opened read-only and
 * only a `Credential.Key` value (`{type: "key", key}`) with a literal key is
 * accepted; OAuth and external values are `invalid`.
 */
export function readOpenCodeDbCredential(
  databasePath: string,
  integrationId: string,
): OpenCodeDbCredential {
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
  let database: { close(): void } | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as SqliteModule;
    const opened = new DatabaseSync(databasePath, { readOnly: true });
    database = opened;
    const row = opened
      .prepare(
        "SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
      )
      .get(integrationId) as { value?: unknown } | undefined;
    if (!row) return { status: "missing" };
    return classifyValue(row.value);
  } catch (error) {
    // A 1.x database has no `credential` table: nothing was stored here.
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return { status: "missing" };
    }
    return { status: "error" };
  } finally {
    try {
      database?.close();
    } catch {
      // Closing a read-only handle has nothing left to lose.
    }
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
