/**
 * Skill 资源文件的上限与路径规则（ADR-0016）——写入口
 * （`src/server/writers/skill.ts`）与技能编辑器（`src/app/skills/skill-files.ts`）
 * 共有的那一份。
 *
 * 放在 `src/lib/` 是因为这两侧都得跑同一套判断，而客户端不能从 `@/server` 导入运行时值；
 * 以前两边各抄一份、靠「改一处必须同步另一处」的注释维持一致，现在只有这一处。
 * 两侧各自还剩自己那半边：写入口管 base64 与 Buffer，编辑器管 `size`、字节格式化与默认路径。
 *
 * 纯模块：不 import 任何东西。
 */

/** 每个技能目录最多带的资源文件数与单文件上限；两侧都要显示，所以都导出。 */
export const SKILL_FILE_MAX_COUNT = 32;
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;
/** 路径长度上限；只有下面这条校验用得着，不外露。 */
const SKILL_FILE_PATH_MAX_LENGTH = 200;

/**
 * 资源文件路径必须能原样落到 data/skills/<slug>/<path> 之下：绝对路径、`..`、空段、
 * 控制字符与反斜杠都拒绝；根下的 SKILL.md 由正文生成，资源文件不能顶替它、也不能拿它当
 * 根下目录名（macOS 文件系统不分大小写，按不区分大小写比较；重复与文件/目录冲突还要折叠
 * Unicode 正规化，见 foldSkillPath）。
 */
export function skillFilePathProblem(path: string): string | null {
  if (path === "") return "资源文件路径不能为空";
  if (path.length > SKILL_FILE_PATH_MAX_LENGTH)
    return `资源文件路径「${path.slice(0, 40)}…」超过 ${SKILL_FILE_PATH_MAX_LENGTH} 个字符`;
  // oxlint-disable-next-line no-control-regex -- 控制字符与 NUL 在文件名里是货真价实的坑
  if (/[\u0000-\u001f\u007f]/.test(path)) return "资源文件路径不能含控制字符";
  if (path.startsWith("/")) return `资源文件路径「${path}」不能是绝对路径`;
  if (path.includes("\\")) return `资源文件路径「${path}」只能用 / 分段`;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..")
      return `资源文件路径「${path}」不能含空段、. 或 ..`;
  }
  if (path.split("/")[0]?.toLowerCase() === "skill.md")
    return "SKILL.md 由正文生成，不能作为资源文件上传，也不能作为目录名";
  return null;
}

/** 文件系统眼里的同一路径：折叠大小写与 Unicode 正规化（APFS / HFS+ 两者都不区分）。 */
export function foldSkillPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}
