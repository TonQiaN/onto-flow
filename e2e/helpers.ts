import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import Database from "better-sqlite3";

/** 一切从仓库根解析：data/ 取自 process.cwd()，换目录就是另一个库（与 src/db/index.ts 同源） */
export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "ontoflow.db");

/**
 * 直接打开本地库写合成夹具行（runs.spec.ts / parallel-ui.spec.ts 的同款模式）。
 * pragma 与 src/db/index.ts 一致：外键级联要生效，WAL 下与 dev server 并发写要等锁而不是立抛 BUSY。
 */
export function openDb(): Database.Database {
  const database = new Database(DB_PATH);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  return database;
}

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
