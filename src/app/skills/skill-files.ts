/**
 * Skill 资源文件的客户端校验：与 src/server/writers/skill.ts 写入口同一套规则，
 * 在上传那一刻就把问题摆进编辑器，而不是等保存被 400 打回。上限与路径规则在两处
 * 各写一份——客户端不能从 @/server 导入运行时值；改一处必须同步另一处。
 */

export const SKILL_FILE_MAX_COUNT = 32;
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;
export const SKILL_FILE_PATH_MAX_LENGTH = 200;

/** 编辑器里的一个资源文件：内容以 base64 持有，保存时原样进载荷 */
export interface SkillFileDraft {
  key: string;
  path: string;
  contentBase64: string;
  size: number;
}

/**
 * 路径必须能原样落到 data/skills/<slug>/<path> 之下：绝对路径、`..`、空段、控制字符与
 * 反斜杠都拒绝；根下的 SKILL.md 由正文生成，资源文件不能顶替它（不区分大小写）。
 */
export function skillFilePathProblem(path: string): string | null {
  if (path === "") return "资源文件路径不能为空";
  if (path.length > SKILL_FILE_PATH_MAX_LENGTH)
    return `资源文件路径「${path.slice(0, 40)}…」超过 ${SKILL_FILE_PATH_MAX_LENGTH} 个字符`;
  // 控制字符与 NUL 在文件名里是货真价实的坑
  if (/[\u0000-\u001f\u007f]/.test(path)) return "资源文件路径不能含控制字符";
  if (path.startsWith("/")) return `资源文件路径「${path}」不能是绝对路径`;
  if (path.includes("\\")) return `资源文件路径「${path}」只能用 / 分段`;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..")
      return `资源文件路径「${path}」不能含空段、. 或 ..`;
  }
  if (path.toLowerCase() === "skill.md")
    return "SKILL.md 由正文生成，不能作为资源文件上传";
  return null;
}

/** 整份清单的问题：数量、单文件大小、路径合法性、重复与文件/目录冲突；合法返回 null */
export function skillFilesProblem(
  files: ReadonlyArray<{ path: string; size: number }>,
): string | null {
  if (files.length > SKILL_FILE_MAX_COUNT)
    return `资源文件最多 ${SKILL_FILE_MAX_COUNT} 个，现有 ${files.length} 个`;
  const paths = new Set<string>();
  for (const file of files) {
    const problem = skillFilePathProblem(file.path);
    if (problem) return problem;
    if (paths.has(file.path)) return `资源文件路径重复：「${file.path}」`;
    if (file.size > SKILL_FILE_MAX_BYTES)
      return `资源文件「${file.path}」超过 1 MiB（${formatBytes(file.size)}）`;
    paths.add(file.path);
  }
  // 同一个名字不能既是文件又是别的文件的目录：投影时 mkdir 会撞上已写好的文件
  for (const path of paths) {
    for (const other of paths) {
      if (other !== path && other.startsWith(`${path}/`))
        return `资源文件路径「${path}」既是文件又是「${other}」的目录`;
    }
  }
  return null;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

/** 上传时的默认路径：目录上传自带相对路径，单文件上传用文件名 */
export function defaultFilePath(file: {
  name: string;
  webkitRelativePath?: string;
}): string {
  const relative = file.webkitRelativePath ?? "";
  return relative !== "" ? relative : file.name;
}

/** base64 字符串对应的字节数（修订面板估算大小用，不解码整份内容） */
export function base64ByteLength(encoded: string): number {
  if (encoded === "") return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}
