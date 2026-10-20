import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SqliteDatabase } from "../src/database.js";
import { DEFAULTS } from "../src/config.js";
import type { DatabaseOptions } from "../src/config.js";

export function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "querylite-mcp-"));
  return {
    path,
    remove() {
      const target = resolve(path);
      if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/).at(-1)?.startsWith("querylite-mcp-")) {
        throw new Error("临时目录不在预期范围内，拒绝清理。");
      }
      rmSync(target, { recursive: true, force: true });
    },
  };
}

export function fixture(overrides: Partial<DatabaseOptions> = {}) {
  const directory = temporaryDirectory();
  const options = {
    ...DEFAULTS,
    path: join(directory.path, "test.sqlite"),
    allowWrite: true,
    create: true,
    ...overrides,
  };
  const database = new SqliteDatabase(options);
  return {
    database,
    options,
    close() {
      database.close();
      directory.remove();
    },
  };
}
