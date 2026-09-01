import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";

/**
 * 写入器的统一返回：成功带 DTO，失败带 HTTP 状态与中文错误信息。
 * route 用 respond() 直接转成响应；回滚（/api/revisions/[revId]/restore）
 * 复用同一结果做错误映射，保证「PUT 与回滚同一条写入路径」。
 */
export type WriteResult<T, Issue = never> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; issues?: Issue[] };

export function writeOk<T>(data: T): WriteResult<T> {
  return { ok: true, data };
}

export function writeFail<Issue = never>(
  status: number,
  error: string,
  issues?: Issue[],
): WriteResult<never, Issue> {
  return { ok: false, status, error, ...(issues ? { issues } : {}) };
}

export function respond<T, Issue>(result: WriteResult<T, Issue>): NextResponse {
  return result.ok
    ? NextResponse.json(result.data)
    : jsonError(
        result.status,
        result.error,
        result.issues ? { issues: result.issues } : undefined,
      );
}

/** 请求体必须是 JSON 对象（非数组、非 null） */
export function asObject(
  raw: unknown,
): { ok: true; body: Record<string, unknown> } | { ok: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false };
  return { ok: true, body: raw as Record<string, unknown> };
}
