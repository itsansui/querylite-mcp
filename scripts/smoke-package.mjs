import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const archive = resolve(`${manifest.name}-${manifest.version}.tgz`);
const directory = mkdtempSync(join(tmpdir(), "querylite-mcp-package-"));
const transport = new StdioClientTransport({
  command: "npx",
  args: ["--yes", "--package", archive, "querylite-mcp", "--db", join(directory, "验证.sqlite"), "--allow-write", "--create"],
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
const client = new Client({ name: "querylite-package-test", version: "1.0.0" });
const deadline = setTimeout(() => {
  process.stderr.write(`安装包验证超时。\n${stderr}\n`);
  void client.close();
  process.exitCode = 1;
}, 60_000);

try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 9);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const created = await call("db_execute", { sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)" });
  assert.notEqual(created.isError, true);
  const inserted = await call("db_insert", { table: "items", values: { name: "安装包测试" } });
  assert.equal(inserted.structuredContent.changes, 1);
  const result = await call("db_query", { sql: "SELECT * FROM items" });
  assert.deepEqual(result.structuredContent.rows, [{ id: 1, name: "安装包测试" }]);
  const updated = await call("db_update", {
    table: "items", values: { name: "已更新" }, where: [{ column: "id", operator: "eq", value: 1 }],
  });
  assert.equal(updated.structuredContent.changes, 1);
  const deleted = await call("db_delete", {
    table: "items", where: [{ column: "id", operator: "eq", value: 1 }],
  });
  assert.equal(deleted.structuredContent.changes, 1);
  process.stdout.write("本地安装包通过 npx 启动，MCP 工具发现与增删改查验证通过。\n");
} catch (error) {
  process.stderr.write(`${stderr}\n`);
  throw error;
} finally {
  clearTimeout(deadline);
  await client.close();
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/).at(-1)?.startsWith("querylite-mcp-package-")) {
    throw new Error("临时目录不在预期范围内，拒绝清理。");
  }
  rmSync(target, { recursive: true, force: true });
}
