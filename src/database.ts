import { closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { DatabaseOptions } from "./config.js";
import { QueryLiteError } from "./errors.js";
import type { Filter, Value } from "./schemas.js";
import { assertReadSql, assertWriteSql, buildWhere, inspectSql, quoteIdentifier } from "./sql.js";

type JsonScalar = string | number | null | { base64: string };
type JsonRow = Record<string, JsonScalar>;
interface WriteResult {
  changes: number;
  lastInsertRowid?: number | string;
}
interface TableColumn {
  name: string;
  hidden: number;
}

function normalizeValue(value: SQLOutputValue): JsonScalar {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  // SQLite 浮点数可能为无穷，使用字符串保留信息。
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function normalizeRow(row: Record<string, SQLOutputValue>): JsonRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function bindValue(value: Value): SQLInputValue {
  if (typeof value === "boolean") return Number(value);
  if (value && typeof value === "object") {
    if ("base64" in value) return Buffer.from(value.base64, "base64");
    const integer = BigInt(value.integer);
    if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) {
      throw new QueryLiteError("INTEGER_OUT_OF_RANGE", "SQLite 整数必须在有符号 64 位范围内。");
    }
    return integer;
  }
  return value;
}

export class SqliteDatabase {
  readonly path: string;
  private readonly reader: DatabaseSync;
  private readonly writer: DatabaseSync | undefined;
  private closed = false;

  constructor(readonly options: DatabaseOptions) {
    if (options.create && !options.allowWrite) {
      throw new QueryLiteError("INVALID_CONFIG", "创建数据库需要启用写入。");
    }
    if (options.path === ":memory:" || /^file:/i.test(options.path)) {
      throw new QueryLiteError("INVALID_CONFIG", "请使用普通 SQLite 文件路径。");
    }
    const path = resolve(options.path);
    if (!existsSync(path)) {
      if (!options.create || !options.allowWrite) {
        throw new QueryLiteError("DATABASE_NOT_FOUND", "数据库文件不存在；创建请同时指定 --allow-write --create。");
      }
      mkdirSync(dirname(path), { recursive: true });
      closeSync(openSync(path, "wx"));
    }
    if (!statSync(path).isFile()) throw new QueryLiteError("INVALID_DATABASE", "数据库路径必须指向普通文件。");
    this.path = realpathSync(path);

    let reader: DatabaseSync | undefined;
    let writer: DatabaseSync | undefined;
    try {
      if (options.allowWrite) {
        writer = new DatabaseSync(this.path, { allowExtension: false, enableForeignKeyConstraints: true });
        this.configure(writer);
      }
      reader = new DatabaseSync(this.path, { readOnly: true, allowExtension: false });
      this.configure(reader);
      reader.exec("PRAGMA query_only = ON");
      // 尽早确认文件确实是 SQLite 数据库。
      reader.prepare("SELECT count(*) FROM main.sqlite_schema").get();
      this.reader = reader;
      this.writer = writer;
    } catch (error) {
      reader?.close();
      writer?.close();
      throw error;
    }
  }

  private configure(database: DatabaseSync): void {
    database.exec(`PRAGMA busy_timeout = ${this.options.busyTimeoutMs}`);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.reader.close();
    } finally {
      this.writer?.close();
    }
  }

  private statement(database: DatabaseSync, sql: string) {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    statement.setAllowBareNamedParameters(false);
    return statement;
  }

  private readAll(sql: string, params: SQLInputValue[] = []): JsonRow[] {
    return this.statement(this.reader, sql).all(...params).map(normalizeRow);
  }

  assertResultSize(result: unknown): void {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > this.options.maxResultBytes) {
      throw new QueryLiteError("RESULT_TOO_LARGE", "结果超过大小上限，请缩小查询范围，或调整 --max-result-bytes。");
    }
  }

  info() {
    return {
      path: this.path,
      readOnly: !this.options.allowWrite,
      sqliteVersion: this.readAll("SELECT sqlite_version() AS version")[0]?.version,
      maxRows: this.options.maxRows,
      maxChanges: this.options.maxChanges,
      maxResultBytes: this.options.maxResultBytes,
      busyTimeoutMs: this.options.busyTimeoutMs,
    };
  }

  listTables(limit = 100, offset = 0) {
    const boundedLimit = Math.min(limit, this.options.maxRows);
    const tables = this.readAll(
      "SELECT name, type, sql FROM main.sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name LIMIT ? OFFSET ?",
      [boundedLimit + 1, offset],
    );
    const truncated = tables.length > boundedLimit;
    return { tables: tables.slice(0, boundedLimit), truncated, nextOffset: truncated ? offset + boundedLimit : null };
  }

  private table(name: string, writable = false): { type: string; columns: TableColumn[] } {
    quoteIdentifier(name);
    const record = this.readAll(
      "SELECT type FROM main.sqlite_schema WHERE name = ? AND type IN ('table', 'view')",
      [name],
    )[0];
    if (!record) throw new QueryLiteError("UNKNOWN_TABLE", `表或视图不存在：${name}`);
    if (writable && (record.type !== "table" || /^sqlite_/i.test(name))) {
      throw new QueryLiteError("TABLE_NOT_WRITABLE", "结构化写入仅支持普通业务表。");
    }
    const columns = this.readAll("SELECT name, hidden FROM pragma_table_xinfo(?, 'main')", [name]).map((column) => ({
      name: String(column.name),
      hidden: Number(column.hidden),
    }));
    return { type: String(record.type), columns };
  }

  describeTable(name: string) {
    const { type } = this.table(name);
    return {
      name,
      type,
      columns: this.readAll("SELECT * FROM pragma_table_xinfo(?, 'main')", [name]),
      foreignKeys: this.readAll("SELECT * FROM pragma_foreign_key_list(?, 'main')", [name]),
      indexes: this.readAll("SELECT name, sql FROM main.sqlite_schema WHERE type = 'index' AND tbl_name = ? ORDER BY name", [name]),
      sql: this.readAll("SELECT sql FROM main.sqlite_schema WHERE name = ?", [name])[0]?.sql,
    };
  }

  query(sql: string, params: Value[] = [], limit?: number) {
    assertReadSql(sql, params.length);
    const rowLimit = Math.min(limit ?? 100, this.options.maxRows);
    if (!Number.isInteger(rowLimit) || rowLimit < 1) throw new QueryLiteError("INVALID_LIMIT", "查询行数必须为正整数。");
    const statement = this.statement(this.reader, sql);
    const rows: JsonRow[] = [];
    let rowBytes = 0;
    let truncated = false;
    let reason: "row_limit" | "byte_limit" | null = null;
    // 为元数据预留空间，迭代读取避免将整个结果装入内存。
    const byteBudget = this.options.maxResultBytes - 256;
    for (const row of statement.iterate(...params.map(bindValue))) {
      if (rows.length >= rowLimit) { truncated = true; reason = "row_limit"; break; }
      const normalized = normalizeRow(row);
      const size = Buffer.byteLength(JSON.stringify(normalized), "utf8") + 1;
      if (rowBytes + size > byteBudget) { truncated = true; reason = "byte_limit"; break; }
      rows.push(normalized);
      rowBytes += size;
    }
    return { rows, rowCount: rows.length, truncated, truncationReason: reason };
  }

  private requireWriter(): DatabaseSync {
    if (!this.writer) throw new QueryLiteError("READ_ONLY", "当前为只读模式，写入需要使用 --allow-write 启动。");
    return this.writer;
  }

  private atomic<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.requireWriter();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      // 在提交前检查响应，避免提交成功后因结果超限而返回失败。
      this.assertResultSize(result);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* SQLite 可能已经自动回滚。 */ }
      throw error;
    }
  }

  private run(database: DatabaseSync, sql: string, params: Value[]): WriteResult {
    const tokens = inspectSql(sql, params.length);
    const raw = this.statement(database, sql).run(...params.map(bindValue));
    const isDml = ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(tokens[0]!);
    const changes = isDml ? Number(raw.changes) : 0;
    if (changes > this.options.maxChanges) {
      throw new QueryLiteError("CHANGE_LIMIT_EXCEEDED", `直接影响行数 ${changes} 超过上限 ${this.options.maxChanges}，操作已回滚。`);
    }
    const result: WriteResult = { changes };
    if (tokens[0] === "INSERT" || tokens[0] === "REPLACE") {
      result.lastInsertRowid = normalizeValue(BigInt(raw.lastInsertRowid)) as number | string;
    }
    return result;
  }

  private writeColumns(table: string, values: Record<string, Value>): { names: string[]; columns: Set<string> } {
    const { columns } = this.table(table, true);
    const writable = new Set(columns.filter((column) => column.hidden === 0).map((column) => column.name));
    const names = Object.keys(values);
    if (!names.length) throw new QueryLiteError("VALUES_REQUIRED", "至少需要一个字段。");
    for (const name of names) {
      if (!writable.has(name)) throw new QueryLiteError("UNKNOWN_COLUMN", `字段不存在或不可写：${name}`);
    }
    return { names, columns: new Set(columns.map((column) => column.name)) };
  }

  insert(table: string, values: Record<string, Value>) {
    return this.atomic((database) => {
      const { names } = this.writeColumns(table, values);
      const sql = `INSERT INTO main.${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
      return this.run(database, sql, names.map((name) => values[name]!));
    });
  }

  update(table: string, values: Record<string, Value>, where: Filter[]) {
    return this.atomic((database) => {
      const { names, columns } = this.writeColumns(table, values);
      const filter = buildWhere(where, columns);
      const sql = `UPDATE main.${quoteIdentifier(table)} SET ${names.map((name) => `${quoteIdentifier(name)} = ?`).join(", ")} WHERE ${filter.sql}`;
      return this.run(database, sql, [...names.map((name) => values[name]!), ...filter.params]);
    });
  }

  delete(table: string, where: Filter[]) {
    return this.atomic((database) => {
      const { columns } = this.table(table, true);
      const filter = buildWhere(where, new Set(columns.map((column) => column.name)));
      return this.run(database, `DELETE FROM main.${quoteIdentifier(table)} WHERE ${filter.sql}`, filter.params);
    });
  }

  execute(sql: string, params: Value[] = []) {
    assertWriteSql(sql, params.length);
    return this.atomic((database) => this.run(database, sql, params));
  }

  transaction(statements: { sql: string; params: Value[] }[]) {
    if (!statements.length || statements.length > 100) {
      throw new QueryLiteError("INVALID_TRANSACTION", "事务必须包含 1～100 条语句。");
    }
    for (const statement of statements) assertWriteSql(statement.sql, statement.params.length);
    return this.atomic((database) => {
      const results: WriteResult[] = [];
      let changes = 0;
      for (const statement of statements) {
        const result = this.run(database, statement.sql, statement.params);
        changes += result.changes;
        if (changes > this.options.maxChanges) {
          throw new QueryLiteError("CHANGE_LIMIT_EXCEEDED", `事务累计直接影响行数超过 ${this.options.maxChanges}，事务已回滚。`);
        }
        results.push(result);
      }
      return { committed: true, changes, results };
    });
  }
}
