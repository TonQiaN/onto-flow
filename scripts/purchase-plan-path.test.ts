import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PURCHASE_PLAN_PATH_HELPERS_SOURCE,
  purchasePlanBackupLocation,
} from "./purchase-plan-path";

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
});
