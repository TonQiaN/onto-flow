/**
 * 运行与工作流标识：它们要作为目录名进入文件系统，因此在创建入口做路径安全校验。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/run/ids.ts。
 */
import { randomBytes } from "node:crypto";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 校验将用作目录名的标识；拒绝路径分隔符、前导点等不安全形状。 */
export function assertSafeId(kind: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}「${value}」不能用作目录名：只允许字母数字开头，后接字母数字、点、下划线或连字符`,
    );
  }
}

/** 生成按时间可排序的唯一运行 id，例如 run-20260826T081530Z-a1b2c3。 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}
