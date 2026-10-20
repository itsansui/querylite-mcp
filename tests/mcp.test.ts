import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DatabaseSync } from "node:sqlite";
import { temporaryDirectory } from "./helpers.js";

async function connect(args: string[]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), ...args],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: "querylite-test", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`MCP 连接失败：${stderr}`, { cause: error });
  }
  return { client, transport, stderr: () => stderr };
}

test("标准输入输出 MCP 完成工具发现、建表和增删改查", { timeout: 20_000 }, async () => {
  const directory = temporaryDirectory();
  const path = join(directory.path, "集成 测试.sqlite");
  const { client, stderr } = await connect(["--db", path, "--allow-write", "--create"]);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert.equal(tools.find((tool) => tool.name === "db_query")?.annotations?.readOnlyHint, true);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    assert.notEqual((await call("db_execute", { sql: "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)" })).isError, true);
    const inserted = await call("db_insert", { table: "users", values: { name: "张三" } });
    assert.equal(inserted.structuredContent?.changes, 1);
    const query = await call("db_query", { sql: "SELECT * FROM users WHERE name=?", params: ["张三"] });
    assert.deepEqual(query.structuredContent?.rows, [{ id: 1, name: "张三" }]);
    assert.equal((await call("db_list_tables", {})).isError, undefined);
    assert.equal((await call("db_describe_table", { table: "users" })).isError, undefined);
    assert.equal((await call("db_update", {
      table: "users", values: { name: "李四" }, where: [{ column: "id", operator: "eq", value: 1 }],
    })).structuredContent?.changes, 1);
    assert.equal((await call("db_delete", {
      table: "users", where: [{ column: "id", operator: "eq", value: 1 }],
    })).structuredContent?.changes, 1);
    assert.equal((await call("db_update", { table: "users", values: { name: "错误" }, where: [] })).isError, true);
    assert.equal((await call("db_query", { sql: "SELECT * FROM missing" })).isError, true);
    const transaction = await call("db_transaction", { statements: [
      { sql: "INSERT INTO users VALUES (?,?)", params: [2, "王五"] },
      { sql: "INSERT INTO missing VALUES(1)" },
    ] });
    assert.equal(transaction.isError, true);
    assert.equal((await call("db_query", { sql: "SELECT * FROM users" })).structuredContent?.rowCount, 0);
    assert.match(stderr(), /已启动/);
  } finally {
    await client.close();
    directory.remove();
  }
});

test("只读 MCP 仅公布四个读取工具，数据库内容保持不变", { timeout: 20_000 }, async () => {
  const directory = temporaryDirectory();
  const path = join(directory.path, "read.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(1)");
  db.close();
  const { client } = await connect(["--db", path]);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "db_describe_table", "db_info", "db_list_tables", "db_query",
    ]);
    const info = await client.callTool({ name: "db_info", arguments: {} });
    assert.equal(info.structuredContent?.readOnly, true);
    const blocked = await client.callTool({
      name: "db_query", arguments: { sql: "WITH x AS (SELECT 2) INSERT INTO items SELECT * FROM x" },
    });
    assert.equal(blocked.isError, true);
    assert.equal((await client.callTool({
      name: "db_query", arguments: { sql: "SELECT * FROM items" },
    })).structuredContent?.rowCount, 1);
  } finally {
    await client.close();
    directory.remove();
  }
});

test("命令行帮助、错误退出和标准输入关闭后的正常退出", { timeout: 10_000 }, () => {
  const cli = resolve("dist/cli.js");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法/);
  const invalid = spawnSync(process.execPath, [cli], { encoding: "utf8", env: { ...process.env, SQLITE_DB_PATH: "" } });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  const directory = temporaryDirectory();
  try {
    const eof = spawnSync(process.execPath, [cli, "--db", join(directory.path, "eof.sqlite"), "--allow-write", "--create"], {
      input: "", encoding: "utf8", timeout: 5_000,
    });
    assert.equal(eof.status, 0, eof.stderr);
    assert.equal(eof.stdout, "");
  } finally {
    directory.remove();
  }
});
