# querylite-mcp

为 Agent 提供本地 SQLite 查询、增删改查与事务能力的 MCP 服务。使用 TypeScript、官方 MCP SDK 和 Node.js 内置 `node:sqlite`，通过标准输入输出通信。

需要 **Node.js >= 22.13.0**。已在 Windows 的 Node.js 22.13.0 和 23.9.0 上通过全部测试。部分版本会输出 SQLite 实验性提示，提示写入标准错误，不影响 MCP 通信。

## 快速开始

```powershell
npm ci
npm run check
npm pack
```

项目尚未发布到 npm 时，使用本地安装包通过 `npx` 启动：

```powershell
npx --yes --package ./querylite-mcp-0.1.0.tgz querylite-mcp --db ./data/app.sqlite --allow-write --create
```

启动后等待 MCP 客户端通过标准输入发送请求。终端中没有交互式命令行提示符属于正常情况。

已有数据库仅开放读取：

```powershell
npx --yes --package ./querylite-mcp-0.1.0.tgz querylite-mcp --db ./data/app.sqlite
```

也可以直接运行构建后的入口：

```powershell
node dist/cli.js --db ./data/app.sqlite --allow-write --create
```

发布到 npm 且包名可用后，用户可以直接运行：

```powershell
npx --yes querylite-mcp --db ./data/app.sqlite --allow-write --create
```

## Agent 配置

以下为支持 `mcpServers` 格式的客户端配置。将安装包与数据库路径替换为实际绝对路径；每个 MCP 进程绑定一个数据库文件。不同客户端的配置文件位置及顶层格式可能不同。

本地安装包：

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "D:/projects/querylite-mcp/querylite-mcp-0.1.0.tgz",
        "querylite-mcp",
        "--db",
        "D:/data/app.sqlite",
        "--allow-write",
        "--create"
      ]
    }
  }
}
```

如果 Windows 客户端无法定位 `npx`，将 `command` 改为 `npx.cmd`，或使用 `node` 加构建产物绝对路径：

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "node",
      "args": [
        "D:/projects/querylite-mcp/dist/cli.js",
        "--db",
        "D:/data/app.sqlite",
        "--allow-write",
        "--create"
      ]
    }
  }
}
```

npm 发布后的配置示例见 [examples/mcp.published.json](examples/mcp.published.json)。只读连接移除 `--allow-write` 和 `--create`。

## 工具

| 工具 | 功能 | 模式 |
| --- | --- | --- |
| `db_info` | 数据库路径、SQLite 版本、读写模式和限制 | 只读、读写 |
| `db_list_tables` | 分页查看业务表、视图和定义 | 只读、读写 |
| `db_describe_table` | 字段、主键、默认值、索引和外键 | 只读、读写 |
| `db_query` | 参数化查询、公共表表达式、执行计划 | 只读、读写 |
| `db_insert` | 新增一条记录 | 读写 |
| `db_update` | 按条件更新记录 | 读写 |
| `db_delete` | 按条件删除记录 | 读写 |
| `db_execute` | 单条写入 SQL 或建表、索引、视图定义 | 读写 |
| `db_transaction` | 原子执行多条写入 SQL | 读写 |

所有工具使用 JSON 结构校验参数。成功结果同时提供 `content` 文本和 `structuredContent`；业务错误设置 `isError: true` 并返回 `{ "error": { "code": "...", "message": "..." } }`。协议层输入错误由 SDK 按 MCP 规范处理。

### 建表

调用 `db_execute`：

```json
{
  "sql": "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1)"
}
```

### 新增

调用 `db_insert`：

```json
{
  "table": "users",
  "values": {
    "name": "张三",
    "email": "zhangsan@example.com",
    "active": true
  }
}
```

返回：

```json
{
  "changes": 1,
  "lastInsertRowid": 1
}
```

`lastInsertRowid` 采用 SQLite 的最近插入行号语义，用于普通 `rowid` 表；它不等于任意表的业务主键，`WITHOUT ROWID` 表不能用它读取新主键。

### 查询

调用 `db_query`：

```json
{
  "sql": "SELECT id, name, email FROM users WHERE active = ? ORDER BY id LIMIT ? OFFSET ?",
  "params": [1, 20, 0],
  "limit": 20
}
```

返回示例：

```json
{
  "rows": [
    {
      "id": 1,
      "name": "张三",
      "email": "zhangsan@example.com"
    }
  ],
  "rowCount": 1,
  "truncated": false,
  "truncationReason": null
}
```

默认读取上限为 100 行，`limit` 可以提高到进程配置的 `--max-rows`。`truncationReason` 为 `row_limit` 或 `byte_limit` 时，结果仅包含已返回部分；使用 SQL 中的 `ORDER BY`、`LIMIT` 和 `OFFSET` 分页。若第一行本身超过字节上限，会返回空行数组并标记 `byte_limit`，需要缩小选取字段或调大字节限制。

绑定值只支持普通 `?` 占位符，且必须与 `params` 数量一致。表名、字段名不能通过 `?` 绑定；结构化工具会检查并转义这些标识符。查询包含重名字段时请显式指定不同别名。

### 条件更新

调用 `db_update`：

```json
{
  "table": "users",
  "values": {
    "email": "new@example.com"
  },
  "where": [
    {
      "column": "id",
      "operator": "eq",
      "value": 1
    }
  ]
}
```

### 条件删除

调用 `db_delete`：

```json
{
  "table": "users",
  "where": [
    {
      "column": "id",
      "operator": "in",
      "values": [1, 2]
    },
    {
      "column": "active",
      "operator": "eq",
      "value": false
    }
  ]
}
```

结构化更新和删除必须包含非空的 `where` 数组，多个条件使用 `AND` 连接。支持：

| 操作符 | 含义 | 参数 |
| --- | --- | --- |
| `eq`、`ne` | 等于、不等于；值为 `null` 时使用 `IS NULL` / `IS NOT NULL` | `value` |
| `gt`、`gte`、`lt`、`lte` | 大于、大于等于、小于、小于等于 | `value` |
| `like` | SQL 模糊匹配 | `value` |
| `in`、`not_in` | 集合匹配，每个集合最多 100 项 | `values` |
| `is_null`、`not_null` | 空值、非空值 | 无 |

需要 `OR`、子查询或其他复杂写入时，可使用参数化 `db_execute`。原始 SQL 的 `UPDATE` 和 `DELETE` 允许整表操作；请先确认范围，影响行数上限仍然生效。

### 事务

调用 `db_transaction`：

```json
{
  "statements": [
    {
      "sql": "INSERT INTO users(name, email) VALUES (?, ?)",
      "params": ["李四", "lisi@example.com"]
    },
    {
      "sql": "UPDATE users SET active = ? WHERE id = ?",
      "params": [0, 1]
    }
  ]
}
```

每个事务支持 1～100 条语句。任何语句失败、直接影响行数超限或事务响应超过字节限制，都会回滚整个事务，包括事务内创建的表和索引。

### 数值和二进制

常规输入支持字符串、有限数值、布尔值和 `null`。布尔值存为整数 `0` / `1`。不安全的 JavaScript 整数会被拒绝；SQLite 有符号 64 位整数和二进制值使用：

```json
{
  "table": "files",
  "values": {
    "large_number": { "integer": "9223372036854775807" },
    "content": { "base64": "AAH/" }
  }
}
```

读取时，超出 JavaScript 安全整数范围的值返回十进制字符串，BLOB 返回 `{ "base64": "..." }`，SQL `NULL` 返回 JSON `null`。特殊浮点无穷值使用字符串表示。

## 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--db` | 无 | SQLite 文件路径，也可通过 `SQLITE_DB_PATH` 提供；命令行优先 |
| `--allow-write` | 关闭 | 注册并开放写入工具 |
| `--create` | 关闭 | 允许创建缺失文件及父目录，要求同时启用写入 |
| `--max-rows` | `1000` | 查询最多返回行数，范围 `1～10000` |
| `--max-changes` | `1000` | 单次写入或整个事务最多直接影响行数，范围 `1～1000000` |
| `--max-result-bytes` | `1048576` | 工具结果 JSON 大小上限，范围 `1024～16777216` |
| `--busy-timeout` | `5000` | 锁等待毫秒数，范围 `0～60000` |
| `--help` / `-h` | 无 | 帮助 |
| `--version` / `-v` | 无 | 版本 |

建议 Agent 配置使用绝对路径。相对路径以服务进程工作目录为基准。不支持 `:memory:` 和 SQLite URI。

## 工程结构与设计

```text
querylite-mcp/
├── src/
│   ├── cli.ts              # npx 可执行入口、标准输入输出及进程退出
│   ├── config.ts           # 参数解析、默认值及配置校验
│   ├── server.ts           # MCP 工具注册、权限声明和响应封装
│   ├── schemas.ts          # 工具参数与条件表达式定义
│   ├── database.ts         # SQLite 连接、查询、写入与事务
│   ├── sql.ts              # 语句边界、占位符和标识符处理
│   ├── errors.ts           # 错误类型和错误归一化
│   ├── version.ts          # 服务版本
│   └── index.ts            # 程序化调用的公共接口
├── tests/                  # 配置、数据库行为及真实 MCP 子进程测试
├── scripts/                # 本地安装包的 npx 验证
├── examples/               # Agent 配置和示例数据库定义
├── docs/                   # 架构说明
├── .github/workflows/      # 持续集成
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
└── LICENSE
```

运行链路：Agent → `npx` → 命令行入口 → MCP 工具 → SQLite 数据访问层 → 指定的数据库文件。更详细的职责和扩展边界见 [docs/architecture.md](docs/architecture.md)。

默认只读，查询连接同时启用文件只读与 `query_only`，扩展加载关闭。写入连接启用外键约束，每次修改使用显式事务，默认保留数据库现有日志模式。

原始写入只开放 `INSERT`、`UPDATE`、`DELETE`、`REPLACE`、表/索引/视图的 `CREATE`、`DROP` 和 `ALTER TABLE`。禁止多语句拼接、`ATTACH`、`DETACH`、`PRAGMA`、手动事务、触发器定义、临时表和虚拟表定义；以 `WITH` 开头的写入也不在开放范围内。现有数据库中的触发器与外键级联仍可能生效，`changes` 和 `--max-changes` 仅统计 SQLite 报告的直接影响行数，不能限制级联、触发器或删除表造成的全部变化。

行数和字节限制控制返回量，不是查询执行时限或内存配额；复杂查询仍可能耗时，单个巨大值也会先由 SQLite 读出再进行字节检查。`--busy-timeout` 仅控制数据库锁等待时间。此服务采用同步数据库访问，适合本地 Agent 的中小规模查询。

## 开发、测试与打包

```powershell
npm run dev -- --db ./data/app.sqlite --allow-write --create
npm run typecheck
npm run check
npm run test:integration
npm run test:package
npm pack --dry-run
```

`npm run check` 执行类型检查、构建和全部测试；`npm run test:package` 打包后通过 `npx` 启动真实 MCP 服务，验证工具发现和数据读写。测试使用独立临时数据库，不操作业务文件。

变更版本时同步修改 `package.json`、`src/version.ts`，并运行 `npm install --package-lock-only`。`npm test` 会自动构建后执行全部测试。首次打包或每次发包时，`prepack` 自动编译 `dist/`。

发布前确认 npm 包名归属、登录账号和版本号，然后执行：

```powershell
npm run check
npm run test:package
npm publish --access public
```

本项目提供了发布所需的可执行入口、类型声明、文件白名单和许可证；当前实现未执行 npm 发布。
