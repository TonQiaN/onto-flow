import { NextResponse } from "next/server";

export function jsonError(status: number, error: string, extra?: object) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** 统一 handler 包装：JSON body 解析失败 → 400；未捕获异常 → 500 并带信息 */
export async function handle<T>(
  fn: () => Promise<T> | T,
): Promise<NextResponse | T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SyntaxError) return jsonError(400, "请求体不是合法 JSON");
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/.test(message))
      return jsonError(409, "名称已存在");
    console.error(err);
    return jsonError(500, message);
  }
}
