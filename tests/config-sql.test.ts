import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseCli } from "../src/config.js";
import { assertReadSql, assertWriteSql, inspectSql, quoteIdentifier } from "../src/sql.js";
import { deleteSchema, valueSchema } from "../src/schemas.js";

test("命令行默认只读，并支持环境变量和显式参数优先", () => {
  const config = parseCli([], { SQLITE_DB_PATH: "sample.sqlite" });
  assert.equal(config.action, "serve");
  if (config.action !== "serve") return;
  assert.equal(config.options.allowWrite, false);
  assert.equal(config.options.path, resolve("sample.sqlite"));
  const explicit = parseCli(["--db", "other.sqlite", "--allow-write"], { SQLITE_DB_PATH: "sample.sqlite" });
  if (explicit.action === "serve") assert.equal(explicit.options.path, resolve("other.sqlite"));
});

test("命令行拒绝缺失路径、错误数值、未授权创建和未知参数", () => {
  for (const args of [
    [], ["--db", ":memory:"], ["--db", "file:test"],
    ["--db", "x", "--create"], ["--db", "x", "--max-rows", "0"],
    ["--db", "x", "--max-changes", "1.5"], ["--db", "x", "--busy-timeout", "60001"],
    ["--db", "x", "--unknown"],
  ]) assert.throws(() => parseCli(args, {}));
  assert.equal(parseCli(["--help"], {}).action, "help");
  assert.equal(parseCli(["--version"], {}).action, "version");
});

test("SQL 检查正确处理字符串、转义标识符和注释中的分号及问号", () => {
  const sql = `/* ? ; */ SELECT 'it''s ?;', "a""b", [semi;colon], \`?\`, ?; -- 尾部注释`;
  assert.equal(inspectSql(sql, 1)[0], "SELECT");
  assertReadSql(sql, 1);
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
});

test("拒绝多语句、未闭合 SQL 以及参数缺失或多余", () => {
  for (const sql of ["SELECT 1; DELETE FROM x", "SELECT 1; ;", "SELECT 'x", "SELECT 1 /*", "SELECT 1\0"]) {
    assert.throws(() => inspectSql(sql, 0));
  }
  assert.throws(() => inspectSql("SELECT ?", 0));
  assert.throws(() => inspectSql("SELECT 1", 1));
  assert.throws(() => inspectSql("SELECT ?1", 1));
  assert.throws(() => inspectSql("SELECT :name", 1));
});

test("读写 SQL 仅开放约定的语句类型", () => {
  for (const sql of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "EXPLAIN QUERY PLAN SELECT 1"]) {
    assert.doesNotThrow(() => assertReadSql(sql, 0));
  }
  for (const sql of ["DELETE FROM x", "PRAGMA user_version", "ATTACH 'x' AS x", "EXPLAIN DELETE FROM x"]) {
    assert.throws(() => assertReadSql(sql, 0));
  }
  for (const sql of ["CREATE TABLE x(id)", "CREATE UNIQUE INDEX x ON a(id)", "DROP VIEW x", "UPDATE a SET x=1"]) {
    assert.doesNotThrow(() => assertWriteSql(sql, 0));
  }
  for (const sql of [
    "ATTACH 'x' AS x", "PRAGMA journal_mode=WAL", "BEGIN", "COMMIT", "VACUUM",
    "SELECT 1", "CREATE TRIGGER x AFTER INSERT ON a BEGIN SELECT 1; END",
    "CREATE VIRTUAL TABLE x USING fts5(a)", "CREATE TEMP TABLE x(a)",
  ]) assert.throws(() => assertWriteSql(sql, 0));
});

test("输入结构拒绝无条件删除、不安全整数和错误二进制编码", () => {
  assert.equal(deleteSchema.safeParse({ table: "users", where: [] }).success, false);
  assert.equal(deleteSchema.safeParse({ table: "users" }).success, false);
  assert.equal(valueSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success, false);
  assert.equal(valueSchema.safeParse({ base64: "invalid?" }).success, false);
  assert.equal(valueSchema.safeParse({ integer: "9223372036854775807" }).success, true);
});
