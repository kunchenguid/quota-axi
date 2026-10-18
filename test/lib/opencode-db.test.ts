import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOpenCodeDbCredential } from "../../src/lib/opencode-db.js";

const hasSqlite3 = spawnSync("sqlite3", ["-version"]).status === 0;

describe("OpenCode database reader with the real sqlite3 CLI", () => {
  it.skipIf(!hasSqlite3)(
    "ignores a startup file that sets json mode and headers",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "quota-axi-opencode-rc-"));
      const originalHome = process.env.HOME;
      try {
        const path = join(directory, "opencode.db");
        const db = new DatabaseSync(path);
        db.exec(
          "create table credential (id text, integration_id text, value text, active integer, time_created integer)",
        );
        db.prepare("insert into credential values (?, ?, ?, ?, ?)").run(
          "a",
          "opencode-go",
          JSON.stringify({ type: "key", key: "synthetic-key-1" }),
          1,
          1,
        );
        db.close();
        writeFileSync(
          join(directory, ".sqliterc"),
          ".mode json\n.headers on\n",
        );
        process.env.HOME = directory;
        expect(await readOpenCodeDbCredential(path, "opencode-go")).toEqual({
          status: "available",
          key: "synthetic-key-1",
        });
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
