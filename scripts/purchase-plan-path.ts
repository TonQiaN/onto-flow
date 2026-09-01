import fs from "node:fs";
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
    absolutePath: resolvePurchasePlanBackupPath(pathModule, dataDir, relativePath),
  };
}

/** 数据库里的旧备份指针只能落在 data/documents/ 下，不能借清理路径删除其他运行数据。 */
export function resolvePurchasePlanBackupPath(
  pathModule: typeof path,
  dataDir: string,
  relativePath: string,
): string {
  const absolute = resolveWithinData(pathModule, dataDir, relativePath);
  const documentsRoot = pathModule.resolve(dataDir, "documents");
  const relative = pathModule.relative(documentsRoot, absolute);
  if (relative === "" || relative.startsWith("..") || pathModule.isAbsolute(relative)) {
    throw new Error("归档备份路径不在 data/documents/ 目录内");
  }
  return absolute;
}

/** 数据库尚未接管备份路径时，失败分支必须删除临时归档；ENOENT 视为已经清理。 */
export function removeUnownedBackup(
  fsModule: Pick<typeof fs, "unlinkSync">,
  absolutePath: string | null,
): string | null {
  if (absolutePath === null) return null;
  try {
    fsModule.unlinkSync(absolutePath);
    return null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/** upsert 已让新备份接管数据库行后，删除不再有主人的上一版；越界指针拒绝删除。 */
export function removeSupersededBackup(
  fsModule: Pick<typeof fs, "unlinkSync">,
  pathModule: typeof path,
  dataDir: string,
  previousRelativePath: string | null,
  currentRelativePath: string,
): string | null {
  if (previousRelativePath === null || previousRelativePath === currentRelativePath) {
    return null;
  }
  try {
    return removeUnownedBackup(
      fsModule,
      resolvePurchasePlanBackupPath(pathModule, dataDir, previousRelativePath),
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Tool 被物化到运行目录，故把同一份已测试函数源码嵌进插件而不是复制一套实现。 */
export const PURCHASE_PLAN_PATH_HELPERS_SOURCE = [
  safePlanNoPathSegment,
  resolveWithinData,
  resolvePurchasePlanBackupPath,
  purchasePlanBackupLocation,
  removeUnownedBackup,
  removeSupersededBackup,
]
  .map((fn) => fn.toString())
  .join("\n\n");
