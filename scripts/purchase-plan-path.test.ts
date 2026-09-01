import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PURCHASE_PLAN_PATH_HELPERS_SOURCE,
  purchasePlanBackupLocation,
  removeUnownedBackup,
  removeSupersededBackup,
  resolvePurchasePlanBackupPath,
} from "./purchase-plan-path";

const seedSource = fs.readFileSync(new URL("./seed.ts", import.meta.url), "utf8");

describe("集采计划归档路径", () => {
  it("../../escape 只能生成 data/documents 内的净化文件名", () => {
    const dataDir = path.resolve("/tmp/ontoflow-data");
    const location = purchasePlanBackupLocation(path, dataDir, "../../escape", "20260826");

    expect(location.relativePath).toBe("documents/escape-20260826.md");
    expect(location.absolutePath).toBe(
      path.join(dataDir, "documents", "escape-20260826.md"),
    );
    expect(path.relative(dataDir, location.absolutePath)).not.toMatch(/^\.\./);
  });

  it("生成插件嵌入的就是被回归测试覆盖的路径函数", () => {
    expect(PURCHASE_PLAN_PATH_HELPERS_SOURCE).toContain("safePlanNoPathSegment");
    expect(PURCHASE_PLAN_PATH_HELPERS_SOURCE).toContain("resolveWithinData");
    expect(PURCHASE_PLAN_PATH_HELPERS_SOURCE).toContain("purchasePlanBackupLocation");
    expect(PURCHASE_PLAN_PATH_HELPERS_SOURCE).not.toContain("import_node");

    const invoke = new Function(
      "path",
      "dataDir",
      "planNo",
      "stamp",
      `${PURCHASE_PLAN_PATH_HELPERS_SOURCE}\n` +
        "return purchasePlanBackupLocation(path, dataDir, planNo, stamp);",
    ) as (
      pathModule: typeof path,
      dataDir: string,
      planNo: string,
      stamp: string,
    ) => { relativePath: string; absolutePath: string };
    expect(invoke(path, "/tmp/ontoflow-data", "../../escape", "20260826").relativePath).toBe(
      "documents/escape-20260826.md",
    );
  });

  it("归档 Tool 用完整 UUID 区分同秒并行备份", () => {
    expect(seedSource).toContain('import { randomUUID } from "node:crypto";');
    expect(seedSource).toContain("randomUUID();");
    expect(seedSource).not.toContain("Math.random().toString(16).slice(2, 6)");
  });

  it("数据库未接管的备份在失败时被删除", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "ontoflow-purchase-backup-"));
    const backup = path.join(root, "failed.md");
    try {
      fs.writeFileSync(backup, "unowned");
      expect(removeUnownedBackup(fs, backup)).toBeNull();
      expect(fs.existsSync(backup)).toBe(false);
      expect(removeUnownedBackup(fs, backup)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("重复归档只删除 data/documents 内已被替换的旧备份", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "ontoflow-purchase-backup-"));
    const documents = path.join(root, "documents");
    const previous = path.join(documents, "CPP-001-old.md");
    try {
      fs.mkdirSync(documents, { recursive: true });
      fs.writeFileSync(previous, "old");
      expect(
        removeSupersededBackup(
          fs,
          path,
          root,
          "documents/CPP-001-old.md",
          "documents/CPP-001-new.md",
        ),
      ).toBeNull();
      expect(fs.existsSync(previous)).toBe(false);
      expect(
        removeSupersededBackup(fs, path, root, "runs/other/artifact.md", "documents/new.md"),
      ).toBe("归档备份路径不在 data/documents/ 目录内");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("旧备份路径解析拒绝 documents 根目录和其他数据目录", () => {
    expect(() => resolvePurchasePlanBackupPath(path, "/tmp/data", "documents")).toThrow(
      "归档备份路径不在 data/documents/ 目录内",
    );
    expect(() => resolvePurchasePlanBackupPath(path, "/tmp/data", "runs/a.md")).toThrow(
      "归档备份路径不在 data/documents/ 目录内",
    );
  });

  it("生成插件嵌入失败备份清理函数", () => {
    expect(PURCHASE_PLAN_PATH_HELPERS_SOURCE).toContain("removeUnownedBackup");
    expect(PURCHASE_PLAN_PATH_HELPERS_SOURCE).toContain("removeSupersededBackup");
    expect(seedSource).toContain("let unownedBackupPath: string | null = null;");
    expect(seedSource).toContain("unownedBackupPath = null;");
    expect(seedSource).toContain("removeUnownedBackup(fs, unownedBackupPath)");
    expect(seedSource).toContain('db.exec("BEGIN IMMEDIATE;")');
    expect(seedSource).toContain("removeSupersededBackup(");
  });
});
