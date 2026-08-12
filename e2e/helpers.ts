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
  // v2 起列表 GET 返回信封 { items, total, page, pageSize }；按前缀搜索并放大页长，
  // 保证一次拿全（MAX_PAGE_SIZE = 100）。
  const res = await request.get(
    `${listPath}?q=${encodeURIComponent(prefix)}&pageSize=100`,
  );
  if (!res.ok()) return;
  const body = (await res.json()) as {
    items?: Array<{ id: string; name: string; builtin?: boolean }>;
  };
  const rows = body.items ?? [];
  for (const row of rows) {
    if (row.builtin) continue;
    if (!row.name.startsWith(prefix)) continue;
    await request.delete(`${listPath}/${row.id}`);
  }
}
