/**
 * 把一个库列表（{ items, total, page, pageSize } 信封）翻到底。pageSize 上限是 100，
 * 库超过 100 项时只取第一页会让后面的实体在集合与候选里凭空消失，且没有任何提示。
 * 只给需要「全量」的页面用（画布候选、工作流设置页）；库页本身仍按页展示。
 */
export async function fetchAllPages<T>(
  baseUrl: string,
  init?: RequestInit,
): Promise<{ ok: true; items: T[] } | { ok: false; status: number }> {
  const items: T[] = [];
  const separator = baseUrl.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const res = await fetch(`${baseUrl}${separator}page=${page}&pageSize=100`, init);
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { items: T[]; total: number; pageSize: number };
    items.push(...body.items);
    if (body.items.length === 0 || items.length >= body.total) return { ok: true, items };
  }
}
