import path from "node:path";

/** plan_no 只参与文件名，不改变数据库里的业务编号。 */
export function safePlanNoPathSegment(pathModule: typeof path, planNo: string): string {
  const basename = pathModule.basename(planNo.replaceAll("\\", "/")).normalize("NFKC");
  const cleaned = basename
    .replace(/[^A-Za-z0-9._\-\u3400-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return !cleaned || cleaned === "." || cleaned === ".." ? "plan" : cleaned;
}

/** 把归档相对路径约束在注入的 data 根内；绝对路径与 `..` 越界一律拒绝。 */
export function resolveWithinData(
  pathModule: typeof path,
  dataDir: string,
  relativePath: string,
): string {
  const root = pathModule.resolve(dataDir);
  const absolute = pathModule.resolve(root, relativePath);
  const relative = pathModule.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || pathModule.isAbsolute(relative)) {
    throw new Error("归档文件路径越界 data/ 目录");
  }
  return absolute;
}

export function purchasePlanBackupLocation(
  pathModule: typeof path,
  dataDir: string,
  planNo: string,
  stamp: string,
): { relativePath: string; absolutePath: string } {
  const relativePath = pathModule.posix.join(
    "documents",
    `${safePlanNoPathSegment(pathModule, planNo)}-${stamp}.md`,
  );
  return {
    relativePath,
    absolutePath: resolveWithinData(pathModule, dataDir, relativePath),
  };
}

/** Tool 被物化到运行目录，故把同一份已测试函数源码嵌进插件而不是复制一套实现。 */
export const PURCHASE_PLAN_PATH_HELPERS_SOURCE = [
  safePlanNoPathSegment,
  resolveWithinData,
  purchasePlanBackupLocation,
]
  .map((fn) => fn.toString())
  .join("\n\n");
