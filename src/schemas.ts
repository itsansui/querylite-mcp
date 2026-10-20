import { z } from "zod";

export const valueSchema = z.union([
  z.null(),
  z.string().max(1_048_576),
  z.number().finite().refine((value) => !Number.isInteger(value) || Number.isSafeInteger(value), {
    message: "大整数请使用 { integer: \"十进制字符串\" }，避免精度丢失。",
  }),
  z.boolean(),
  z.strictObject({
    integer: z.string().regex(/^-?(0|[1-9]\d*)$/).max(20),
  }),
  z.strictObject({
    base64: z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
]);
export type Value = z.infer<typeof valueSchema>;

export const identifierSchema = z.string().min(1).max(255).refine((value) => !value.includes("\0"), {
  message: "标识符不能包含空字符。",
});
export const sqlSchema = z.string().min(1).max(100_000);
export const paramsSchema = z.array(valueSchema).max(1_000).default([]);
export const valuesSchema = z.record(identifierSchema, valueSchema).refine(
  (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 100,
  { message: "必须提供 1～100 个字段。" },
);

const comparisonSchema = z.strictObject({
  column: identifierSchema,
  operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "like"]),
  value: valueSchema,
});
const membershipSchema = z.strictObject({
  column: identifierSchema,
  operator: z.enum(["in", "not_in"]),
  values: z.array(valueSchema).min(1).max(100),
});
const nullSchema = z.strictObject({
  column: identifierSchema,
  operator: z.enum(["is_null", "not_null"]),
});
export const filterSchema = z.union([comparisonSchema, membershipSchema, nullSchema]);
export const whereSchema = z.array(filterSchema).min(1).max(50).describe("至少一个条件，多个条件以 AND 连接。");
export type Filter = z.infer<typeof filterSchema>;

export const querySchema = z.strictObject({
  sql: sqlSchema.describe("单条 SELECT、WITH 或 EXPLAIN 语句；绑定参数使用 ?。"),
  params: paramsSchema,
  limit: z.number().int().min(1).max(10_000).optional(),
});
export const insertSchema = z.strictObject({ table: identifierSchema, values: valuesSchema });
export const updateSchema = z.strictObject({ table: identifierSchema, values: valuesSchema, where: whereSchema });
export const deleteSchema = z.strictObject({ table: identifierSchema, where: whereSchema });
export const executeSchema = z.strictObject({ sql: sqlSchema, params: paramsSchema });
export const transactionSchema = z.strictObject({
  statements: z.array(executeSchema).min(1).max(100),
});
