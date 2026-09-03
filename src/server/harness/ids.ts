/**
 * 运行与工作流标识：它们要作为目录名进入文件系统，因此在创建入口做路径安全校验。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/run/ids.ts。
 */
import { randomBytes } from "node:crypto";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// 节点 id 会直接成为 inputs/ 下的目录段；给常见 255-byte 上限留足实现余量。
const SAFE_ID_MAX_LENGTH = 120;

/**
 * 校验机器生成的标识（运行、工作流、节点 id）。这类值本就是 ASCII，
 * 收得死一点没有代价；长度在写入边界限制，不能等运行异步 mkdir 才失败。
 */
export function assertSafeId(kind: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value) || value.length > SAFE_ID_MAX_LENGTH) {
    throw new Error(
      `${kind}「${value}」不能用作目录名：只允许字母数字开头，后接字母数字、点、下划线或连字符，且不能超过 ${SAFE_ID_MAX_LENGTH} 个 ASCII 字符`,
    );
  }
}

/**
 * 校验**用户起的名字**将用作目录名或文件名。本仓库的实体名一律是中文
 * （见 AGENTS.md 的 Conventions），所以这里不能限制字符集，只能挡住真正
 * 危险的形状：路径分隔符、控制字符、前导点、`..`、首尾空白。
 */
export function assertSafeName(kind: string, value: string): void {
  const bad =
    value === "" ||
    value !== value.trim() ||
    value.startsWith(".") ||
    value === ".." ||
    /[/\\]/.test(value) ||
    // oxlint-disable-next-line no-control-regex -- 显式匹配控制字符：它们在文件名里是货真价实的坑
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.length > 120;
  if (bad) {
    throw new Error(
      `${kind}「${value}」不能用作目录名：不能为空或含路径分隔符、控制字符、前导点，也不能超过 120 字`,
    );
  }
}

/** 生成按时间可排序的唯一运行 id，例如 run-20260826T081530Z-a1b2c3。 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}
