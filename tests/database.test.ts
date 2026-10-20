import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "../src/database.js";
import { DEFAULTS } from "../src/config.js";
import { fixture, temporaryDirectory } from "./helpers.js";

test("完成建表、参数化新增、查询、条件更新和条件删除", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const db = f.database;
  assert.equal(db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER)").changes, 0);
  const inserted = db.insert("users", { name: "张三", active: true });
  assert.equal(inserted.changes, 1);
  assert.equal(inserted.lastInsertRowid, 1);
  assert.deepEqual(db.query("SELECT * FROM users WHERE name = ?", ["张三"]).rows, [
    { id: 1, name: "张三", active: 1 },
  ]);
  assert.equal(db.update("users", { name: "李四" }, [{ column: "id", operator: "eq", value: 1 }]).changes, 1);
  assert.equal(db.describeTable("users").columns.length, 3);
  assert.equal(db.listTables().tables[0]?.name, "users");
  assert.equal(db.delete("users", [{ column: "name", operator: "eq", value: "李四" }]).changes, 1);
  assert.equal(db.query("SELECT * FROM users").rowCount, 0);
});

test("标识符安全转义、值参数化，注入内容作为普通数据保存", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const db = f.database;
  db.execute('CREATE TABLE "odd""table" ("a""column" TEXT)');
  const text = "x'); DROP TABLE users; --";
  db.insert('odd"table', { 'a"column': text });
  assert.equal(db.query('SELECT * FROM "odd""table"').rows[0]?.['a"column'], text);
  assert.throws(() => db.insert('odd"table', { 'x" = 1; DROP TABLE users; --': 1 }), /字段不存在/);
});

test("只读连接阻止 WITH 包装写入，并禁止查询接口执行其他写语句", (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.database.execute("CREATE TABLE users(id INTEGER PRIMARY KEY)");
  assert.throws(() => f.database.query("WITH x AS (SELECT 1) INSERT INTO users SELECT * FROM x"), /readonly|read-only/i);
  assert.throws(() => f.database.query("DELETE FROM users"));
  assert.throws(() => f.database.query("SELECT load_extension(?)", ["missing"]));
  assert.equal(f.database.query("SELECT * FROM users").rowCount, 0);
});

test("只读服务拒绝所有数据库写入", (t) => {
  const f = fixture();
  f.database.execute("CREATE TABLE users(id INTEGER PRIMARY KEY)");
  const reader = new SqliteDatabase({ ...f.options, allowWrite: false, create: false });
  t.after(() => { reader.close(); f.close(); });
  assert.equal(reader.info().readOnly, true);
  assert.throws(() => reader.execute("INSERT INTO users VALUES(1)"), /只读模式/);
  assert.throws(() => reader.insert("users", { id: 1 }), /只读模式/);
  assert.equal(reader.query("SELECT count(*) AS total FROM users").rows[0]?.total, 0);
});

test("事务中任一语句失败后回滚全部数据和 DDL", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const db = f.database;
  db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
  assert.throws(() => db.transaction([
    { sql: "INSERT INTO users VALUES (?, ?)", params: [1, "重复"] },
    { sql: "INSERT INTO users VALUES (?, ?)", params: [2, "重复"] },
  ]), /UNIQUE/);
  assert.equal(db.query("SELECT * FROM users").rowCount, 0);
  assert.throws(() => db.transaction([
    { sql: "CREATE TABLE temporary(id INTEGER)", params: [] },
    { sql: "INSERT INTO missing VALUES(1)", params: [] },
  ]));
  assert.equal(db.listTables().tables.length, 1);
  const result = db.transaction([
    { sql: "INSERT INTO users VALUES (?, ?)", params: [1, "甲"] },
    { sql: "INSERT INTO users VALUES (?, ?)", params: [2, "乙"] },
  ]);
  assert.equal(result.committed, true);
  assert.equal(result.changes, 2);
});

test("单次和累计写入超限会回滚；DDL 不误计上一次写入的影响行数", (t) => {
  const f = fixture({ maxChanges: 2 });
  t.after(() => f.close());
  const db = f.database;
  db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, value TEXT)");
  assert.equal(db.execute("INSERT INTO users VALUES(1,'a'),(2,'b')").changes, 2);
  assert.equal(db.execute("CREATE INDEX users_value ON users(value)").changes, 0);
  db.insert("users", { id: 3, value: "c" });
  assert.throws(() => db.update("users", { value: "changed" }, [{ column: "id", operator: "gte", value: 1 }]), /已回滚/);
  assert.equal(db.query("SELECT value FROM users WHERE id=1").rows[0]?.value, "a");
  assert.throws(() => db.transaction([
    { sql: "UPDATE users SET value='x' WHERE id IN (1,2)", params: [] },
    { sql: "DELETE FROM users WHERE id=3", params: [] },
  ]), /已回滚/);
  assert.equal(db.query("SELECT * FROM users").rowCount, 3);
  assert.equal(db.query("SELECT value FROM users WHERE id=1").rows[0]?.value, "a");
});

test("外键约束生效，支持 NULL、集合条件，拒绝空条件", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const db = f.database;
  db.execute("CREATE TABLE parent(id INTEGER PRIMARY KEY)");
  db.execute("CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), value TEXT)");
  assert.throws(() => db.insert("child", { id: 1, parent_id: 999 }), /FOREIGN KEY/);
  db.insert("child", { id: 1, parent_id: null, value: null });
  db.insert("child", { id: 2, parent_id: null, value: "数据" });
  assert.equal(db.update("child", { value: "已更新" }, [
    { column: "value", operator: "eq", value: null },
    { column: "id", operator: "in", values: [1, 2] },
  ]).changes, 1);
  assert.throws(() => db.delete("child", []), /至少一个条件/);
  assert.throws(() => db.update("child", { value: "x" }, []), /至少一个条件/);
  assert.equal(db.delete("child", [{ column: "parent_id", operator: "is_null" }]).changes, 2);
});

test("大整数与 BLOB 无损往返，越界整数被拒绝", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const db = f.database;
  db.execute("CREATE TABLE data(id INTEGER PRIMARY KEY, number INTEGER, bytes BLOB)");
  db.insert("data", { id: 1, number: { integer: "9223372036854775807" }, bytes: { base64: "AAH/" } });
  assert.deepEqual(db.query("SELECT * FROM data").rows[0], {
    id: 1, number: "9223372036854775807", bytes: { base64: "AAH/" },
  });
  assert.throws(() => db.insert("data", { number: { integer: "9223372036854775808" } }), /64 位/);
  assert.equal(db.query("SELECT * FROM data").rowCount, 1);
});

test("行数和字节限制返回截断标记，达到恰好行数时不误报", (t) => {
  const f = fixture({ maxRows: 2, maxResultBytes: 1_024 });
  t.after(() => f.close());
  assert.equal(f.database.query("SELECT 1 UNION ALL SELECT 2", [], 2).truncated, false);
  const rows = f.database.query("SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3", [], 20);
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.truncationReason, "row_limit");
  const bytes = f.database.query("SELECT printf('%2000s', 'x') AS value");
  assert.equal(bytes.truncationReason, "byte_limit");
  assert.equal(bytes.rowCount, 0);
});

test("超出响应上限的事务在提交前回滚", (t) => {
  const f = fixture({ maxResultBytes: 1_024 });
  t.after(() => f.close());
  f.database.execute("CREATE TABLE data(id INTEGER PRIMARY KEY)");
  assert.throws(() => f.database.transaction(Array.from({ length: 100 }, (_, i) => ({
    sql: "INSERT INTO data VALUES (?)", params: [i],
  }))), /大小上限/);
  assert.equal(f.database.query("SELECT * FROM data").rowCount, 0);
});

test("查询完成后释放读取游标，其他连接可以立即写入", (t) => {
  const f = fixture({ maxRows: 1, busyTimeoutMs: 0 });
  t.after(() => f.close());
  f.database.execute("CREATE TABLE data(id INTEGER)");
  f.database.execute("INSERT INTO data VALUES (1),(2)");
  f.database.query("SELECT * FROM data", [], 1);
  const other = new DatabaseSync(f.options.path);
  try {
    assert.doesNotThrow(() => other.prepare("INSERT INTO data VALUES(3)").run());
  } finally {
    other.close();
  }
});

test("生成字段不可写，视图可以查询并查看结构", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const db = f.database;
  db.execute("CREATE TABLE numbers(value INTEGER, doubled INTEGER GENERATED ALWAYS AS(value*2) STORED)");
  db.execute("CREATE VIEW number_view AS SELECT * FROM numbers");
  assert.throws(() => db.insert("numbers", { doubled: 2 }), /不可写/);
  db.insert("numbers", { value: 2 });
  assert.equal(db.query("SELECT * FROM number_view").rows[0]?.doubled, 4);
  assert.equal(db.describeTable("number_view").type, "view");
  assert.throws(() => db.insert("number_view", { value: 3 }), /普通业务表/);
});

test("缺失文件默认不创建，显式创建支持中文和空格路径", () => {
  const directory = temporaryDirectory();
  const path = join(directory.path, "中文 目录", "数据.sqlite");
  try {
    assert.throws(() => new SqliteDatabase({ ...DEFAULTS, path, create: false, allowWrite: false }), /文件不存在/);
    assert.equal(existsSync(path), false);
    const db = new SqliteDatabase({ ...DEFAULTS, path, create: true, allowWrite: true });
    db.close();
    db.close();
    assert.equal(existsSync(path), true);
  } finally {
    directory.remove();
  }
});
