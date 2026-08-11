import type { APIRequestContext } from "@playwright/test";

/**
 * 删除名称以指定前缀开头的测试自建实体（幂等）。
 * 只会命中 e2e 前缀命名的实体，绝不触碰种子数据；builtin 一律跳过。
 */
export async function cleanupByPrefix(
  request: APIRequestContext,
  listPath: string,
  prefix: string,
): Promise<void> {
  const res = await request.get(listPath);
  if (!res.ok()) return;
  const rows = (await res.json()) as Array<{
    id: string;
    name: string;
    builtin?: boolean;
  }>;
  for (const row of rows) {
    if (row.builtin) continue;
    if (!row.name.startsWith(prefix)) continue;
    await request.delete(`${listPath}/${row.id}`);
  }
}
