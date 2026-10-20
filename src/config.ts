import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { QueryLiteError } from "./errors.js";

export interface DatabaseOptions {
  path: string;
  allowWrite: boolean;
  create: boolean;
  maxRows: number;
  maxChanges: number;
  maxResultBytes: number;
  busyTimeoutMs: number;
}

export const DEFAULTS = {
  maxRows: 1_000,
  maxChanges: 1_000,
  maxResultBytes: 1_048_576,
  busyTimeoutMs: 5_000,
} as const;

export const HELP = `querylite-mcp：本地 SQLite MCP 服务

用法：
  npx querylite-mcp --db <数据库路径> [选项]

选项：
  --db <路径>                  SQLite 文件路径，也可使用 SQLITE_DB_PATH
  --allow-write               开放新增、更新、删除、执行 SQL 和事务工具
  --create                    文件不存在时创建，必须同时指定 --allow-write
  --max-rows <数量>            单次查询最多返回行数，默认 1000，范围 1～10000
  --max-changes <数量>         单次写入或整个事务最多直接影响行数，默认 1000
  --max-result-bytes <字节>    单次工具结果大小上限，默认 1048576
  --busy-timeout <毫秒>        数据库锁等待时间，默认 5000，范围 0～60000
  -h, --help                  显示帮助
  -v, --version               显示版本

示例：
  npx querylite-mcp --db ./data/app.sqlite
  npx querylite-mcp --db ./data/app.sqlite --allow-write --create

服务通过标准输入输出通信，运行日志写入标准错误。
`;

function integerOption(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new QueryLiteError("INVALID_CONFIG", `${name} 必须是整数。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new QueryLiteError("INVALID_CONFIG", `${name} 必须在 ${min}～${max} 之间。`);
  }
  return number;
}

export function parseCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { action: "help" } | { action: "version" } | { action: "serve"; options: DatabaseOptions } {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      db: { type: "string" },
      "allow-write": { type: "boolean", default: false },
      create: { type: "boolean", default: false },
      "max-rows": { type: "string" },
      "max-changes": { type: "string" },
      "max-result-bytes": { type: "string" },
      "busy-timeout": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return { action: "help" };
  if (values.version) return { action: "version" };
  const path = values.db ?? env.SQLITE_DB_PATH;
  if (!path?.trim()) throw new QueryLiteError("INVALID_CONFIG", "请通过 --db 或 SQLITE_DB_PATH 指定数据库文件。");
  if (path === ":memory:" || /^file:/i.test(path) || path.includes("\0")) {
    throw new QueryLiteError("INVALID_CONFIG", "请使用普通 SQLite 文件路径，不支持内存数据库或 URI。");
  }
  if (values.create && !values["allow-write"]) {
    throw new QueryLiteError("INVALID_CONFIG", "--create 必须同时指定 --allow-write。");
  }
  return {
    action: "serve",
    options: {
      path: resolve(path),
      allowWrite: values["allow-write"],
      create: values.create,
      maxRows: integerOption(values["max-rows"], DEFAULTS.maxRows, "--max-rows", 1, 10_000),
      maxChanges: integerOption(values["max-changes"], DEFAULTS.maxChanges, "--max-changes", 1, 1_000_000),
      maxResultBytes: integerOption(values["max-result-bytes"], DEFAULTS.maxResultBytes, "--max-result-bytes", 1_024, 16_777_216),
      busyTimeoutMs: integerOption(values["busy-timeout"], DEFAULTS.busyTimeoutMs, "--busy-timeout", 0, 60_000),
    },
  };
}
