/**
 * folders 服务层测试：跑在内存 SQLite 上。
 * src/db/index.ts 会优先复用 globalThis 上已有的 ontoflowDb 单例，
 * 所以必须在（动态）import 服务层之前把内存库塞进全局，避免碰真实 data/ontoflow.db。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { WriteResult } from "./writers/types";
import type { FolderDto } from "./folders";
import { createTestDb, resetTestDb } from "./writers/test-db";

const { sqlite } = await createTestDb();

const { createFolder, deleteFolder, listFolders, updateFolder } = await import("./folders");

/** 展开 WriteResult，失败时直接让用例挂掉 */
function unwrap<T>(r: WriteResult<T>): T {
  if (!r.ok) throw new Error(`${r.status}: ${r.error}`);
  return r.data;
}

function rootFoldersNamed(name: string): FolderDto[] {
  return listFolders().filter((f) => f.name === name && f.parentId === null);
}

beforeEach(() => {
  // 自引用外键下父子行删除顺序难保证，清库时临时关掉 FK 检查
  sqlite.pragma("foreign_keys = OFF");
  resetTestDb(sqlite);
  sqlite.pragma("foreign_keys = ON");
});

describe("deleteFolder 内容上移的同级重名防护", () => {
  it("子文件夹与目标层级现有文件夹同名时 409，不动任何数据", () => {
    const x = unwrap(createFolder("X", null));
    const a = unwrap(createFolder("A", null));
    const ax = unwrap(createFolder("X", a.id));

    const res = deleteFolder(a.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);

    // A 与 A/X 原样保留，根级仍只有一个 X——同级同名不变量未被打破
    const all = listFolders();
    expect(all).toHaveLength(3);
    expect(all.find((f) => f.id === a.id)?.parentId).toBeNull();
    expect(all.find((f) => f.id === ax.id)?.parentId).toBe(a.id);
    expect(rootFoldersNamed("X")).toHaveLength(1);
    expect(rootFoldersNamed("X")[0]?.id).toBe(x.id);
  });

  it("冲突子文件夹改名后删除成功，内容上移到父级", () => {
    unwrap(createFolder("X", null));
    const a = unwrap(createFolder("A", null));
    const ax = unwrap(createFolder("X", a.id));

    unwrap(updateFolder(ax.id, { name: "Y" }));
    expect(unwrap(deleteFolder(a.id))).toEqual({ ok: true });

    const all = listFolders();
    expect(all.find((f) => f.id === a.id)).toBeUndefined();
    expect(all.find((f) => f.id === ax.id)?.parentId).toBeNull();
  });

  it("子文件夹与被删文件夹自身同名不算冲突（父名随删除消失）", () => {
    const a = unwrap(createFolder("A", null));
    const aa = unwrap(createFolder("A", a.id));

    expect(unwrap(deleteFolder(a.id))).toEqual({ ok: true });

    const rootA = rootFoldersNamed("A");
    expect(rootA).toHaveLength(1);
    expect(rootA[0]?.id).toBe(aa.id);
  });
});
