// Errors the CLI reports: a code (stable, for scripts and agents) and a message.

import { WuapiError } from "@wuapidev/sdk";

export class CliError extends Error {
  readonly code: string;
  /** 2 for usage errors, 1 otherwise. */
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: { exitCode?: number; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export const usage = (message: string, details?: Record<string, unknown>) =>
  new CliError("usage", message, { exitCode: 2, ...(details ? { details } : {}) });

export interface ErrorBody {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
  details?: Record<string, unknown>;
}

/** Never carries a key: WuapiError messages and details come from the API, which never echoes it. */
export function toErrorBody(e: unknown): { body: ErrorBody; exitCode: number } {
  if (e instanceof CliError) {
    return { body: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }, exitCode: e.exitCode };
  }
  if (e instanceof WuapiError) {
    const details = e.details && !("account" in e.details) ? e.details : undefined;
    return {
      body: {
        code: e.code,
        message: e.message,
        ...(e.status ? { status: e.status } : {}),
        ...(e.requestId ? { requestId: e.requestId } : {}),
        ...(details ? { details } : {}),
      },
      exitCode: 1,
    };
  }
  const err = e as { code?: unknown; message?: unknown };
  return {
    body: { code: typeof err?.code === "string" ? err.code : "internal_error", message: typeof err?.message === "string" ? err.message : String(e) },
    exitCode: 1,
  };
}
