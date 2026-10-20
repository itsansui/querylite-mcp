export class QueryLiteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QueryLiteError";
  }
}

export function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof QueryLiteError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "DATABASE_ERROR";
    return { code, message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: String(error) };
}
