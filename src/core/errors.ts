import { z } from "zod";

type ErrorCode = "INVALID_ARGUMENT" | "PROJECT_NOT_FOUND" | "ARTICLE_INVALID" | "PERMISSION_DENIED" | "IO_ERROR" | "CANCELLED";
type ExitCode = 2 | 3 | 4 | 5 | 130;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;

  constructor({ code, message, exitCode }: { code: ErrorCode; message: string; exitCode: ExitCode }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const systemErrorSchema = z.object({ code: z.string(), message: z.string() });

export function systemErrorCode(error: unknown): string | undefined {
  const parsed = systemErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

export function normalizeError(error: unknown, signal: AbortSignal): AppError {
  if (signal.aborted) return new AppError({ code: "CANCELLED", message: "操作已取消", exitCode: 130 });
  if (error instanceof AppError) return error;
  if (error instanceof z.ZodError) {
    return new AppError({ code: "INVALID_ARGUMENT", message: z.prettifyError(error), exitCode: 2 });
  }
  const systemError = systemErrorSchema.safeParse(error);
  if (systemError.success) {
    const denied = ["EACCES", "EPERM", "EROFS"].includes(systemError.data.code);
    return new AppError({ code: denied ? "PERMISSION_DENIED" : "IO_ERROR", message: systemError.data.message, exitCode: denied ? 4 : 5 });
  }
  return new AppError({ code: "IO_ERROR", message: error instanceof Error ? error.message : "操作失败", exitCode: 5 });
}
