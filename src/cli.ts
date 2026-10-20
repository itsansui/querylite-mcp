#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HELP, parseCli } from "./config.js";
import { SqliteDatabase } from "./database.js";
import { errorDetails } from "./errors.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

try {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.action === "help") {
    process.stdout.write(HELP);
  } else if (parsed.action === "version") {
    process.stdout.write(`${VERSION}\n`);
  } else {
    const database = new SqliteDatabase(parsed.options);
    const handle = serveStdio(() => createServer(database), {
      onerror: (error) => process.stderr.write(`[querylite-mcp] ${JSON.stringify(errorDetails(error))}\n`),
    });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await handle.close();
      } finally {
        database.close();
      }
    };
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
    process.stdin.once("end", () => { void shutdown(); });
    process.once("exit", () => database.close());
    process.stderr.write(`[querylite-mcp] 已启动，${parsed.options.allowWrite ? "读写" : "只读"}模式，数据库：${database.path}\n`);
  }
} catch (error) {
  process.stderr.write(`[querylite-mcp] ${JSON.stringify(errorDetails(error))}\n`);
  process.exitCode = 1;
}
