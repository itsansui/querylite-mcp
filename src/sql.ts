import { QueryLiteError } from "./errors.js";
import type { Filter, Value } from "./schemas.js";

export function quoteIdentifier(value: string): string {
  if (!value.length || value.length > 255 || value.includes("\0")) {
    throw new QueryLiteError("INVALID_IDENTIFIER", "标识符长度必须为 1～255，且不能包含空字符。");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

// 仅做语句边界和参数检查，语法与读写权限最终由 SQLite 校验。
export function inspectSql(sql: string, parameterCount: number): string[] {
  if (!sql.trim() || sql.length > 100_000 || sql.includes("\0")) {
    throw new QueryLiteError("INVALID_SQL", "SQL 不能为空、包含空字符或超过 100000 个字符。");
  }
  const tokens: string[] = [];
  let parameters = 0;
  let ended = false;
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new QueryLiteError("INVALID_SQL", "SQL 注释没有闭合。");
      index = end + 2;
      continue;
    }
    if (ended) throw new QueryLiteError("MULTIPLE_STATEMENTS", "每次仅允许一条 SQL；多条写入请使用 db_transaction。");
    if (char === ";") { ended = true; index++; continue; }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let closed = false;
      index++;
      while (index < sql.length) {
        if (sql[index] === close) {
          index++;
          if (char !== "[" && sql[index] === close) { index++; continue; }
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) throw new QueryLiteError("INVALID_SQL", "SQL 字符串或标识符没有闭合。");
      tokens.push("<QUOTED>");
      continue;
    }
    if (char === "?") {
      if (next && /\d/.test(next)) {
        throw new QueryLiteError("INVALID_PARAMETERS", "仅支持普通 ? 占位符，不支持 ?NNN。");
      }
      parameters++;
    }
    if (char === ":" || char === "@" || char === "$") {
      throw new QueryLiteError("INVALID_PARAMETERS", "请使用 ? 占位符和 params 数组，不支持命名参数。");
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++;
      tokens.push(sql.slice(start, index).toUpperCase());
    } else {
      tokens.push(char);
      index++;
    }
  }
  if (!tokens.length) throw new QueryLiteError("INVALID_SQL", "SQL 必须包含可执行语句。");
  if (parameters !== parameterCount) {
    throw new QueryLiteError("INVALID_PARAMETERS", `SQL 需要 ${parameters} 个参数，实际收到 ${parameterCount} 个。`);
  }
  return tokens;
}

export function assertReadSql(sql: string, parameterCount: number): void {
  const tokens = inspectSql(sql, parameterCount);
  let first = tokens[0];
  if (first === "EXPLAIN") {
    first = tokens[1] === "QUERY" && tokens[2] === "PLAN" ? tokens[3] : tokens[1];
  }
  if (first !== "SELECT" && first !== "WITH") {
    throw new QueryLiteError("READ_ONLY_SQL", "查询仅支持 SELECT、WITH 和对应的 EXPLAIN。");
  }
}

export function assertWriteSql(sql: string, parameterCount: number): void {
  const tokens = inspectSql(sql, parameterCount);
  if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(tokens[0]!)) return;
  if (tokens[0] === "ALTER" && tokens[1] === "TABLE") return;
  if (tokens[0] === "CREATE" || tokens[0] === "DROP") {
    const kind = tokens[1] === "UNIQUE" && tokens[0] === "CREATE" ? tokens[2] : tokens[1];
    if (kind && ["TABLE", "INDEX", "VIEW"].includes(kind)) return;
  }
  throw new QueryLiteError(
    "WRITE_SQL_NOT_ALLOWED",
    "写入仅支持 INSERT、UPDATE、DELETE、REPLACE，以及 TABLE/INDEX/VIEW 的 CREATE/DROP 和 ALTER TABLE；事务请使用 db_transaction。",
  );
}

export function buildWhere(filters: Filter[], validColumns: Set<string>): { sql: string; params: Value[] } {
  if (!filters.length) throw new QueryLiteError("WHERE_REQUIRED", "更新和删除必须提供至少一个条件。");
  const params: Value[] = [];
  const expressions = filters.map((filter) => {
    if (!validColumns.has(filter.column)) throw new QueryLiteError("UNKNOWN_COLUMN", `字段不存在：${filter.column}`);
    const column = quoteIdentifier(filter.column);
    if (filter.operator === "is_null") return `${column} IS NULL`;
    if (filter.operator === "not_null") return `${column} IS NOT NULL`;
    if ("values" in filter) {
      if (!filter.values.length) throw new QueryLiteError("INVALID_FILTER", "集合条件至少包含一个值。");
      params.push(...filter.values);
      return `${column} ${filter.operator === "in" ? "IN" : "NOT IN"} (${filter.values.map(() => "?").join(", ")})`;
    }
    if (!("value" in filter)) throw new QueryLiteError("INVALID_FILTER", "条件缺少值。");
    if (filter.value === null) {
      if (filter.operator === "eq") return `${column} IS NULL`;
      if (filter.operator === "ne") return `${column} IS NOT NULL`;
      throw new QueryLiteError("INVALID_FILTER", "NULL 只能搭配 eq、ne、is_null 或 not_null。");
    }
    const operators = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE" } as const;
    params.push(filter.value);
    return `${column} ${operators[filter.operator]} ?`;
  });
  return { sql: expressions.join(" AND "), params };
}
