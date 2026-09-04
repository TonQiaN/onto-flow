/**
 * Skill 编辑器专属的那半边：浏览器拿到的是 File 对象与 base64，所以按 `size` 判大小、
 * 顺带管字节格式化与默认路径。上限与路径规则本身在 `@/lib/skill-files`，与写入口
 * （src/server/writers/skill.ts）共用同一份，不再两处各抄一遍。
 */
import {
  foldSkillPath,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_MAX_COUNT,
  skillFilePathProblem,
} from "@/lib/skill-files";

/** 编辑器里的一个资源文件：内容以 base64 持有，保存时原样进载荷 */
export interface SkillFileDraft {
  key: string;
  path: string;
  contentBase64: string;
  size: number;
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
    if (paths.has(foldSkillPath(file.path)))
      return `资源文件路径重复（不区分大小写与 Unicode 正规化）：「${file.path}」`;
    if (file.size > SKILL_FILE_MAX_BYTES)
      return `资源文件「${file.path}」超过 1 MiB（${formatBytes(file.size)}）`;
    paths.add(foldSkillPath(file.path));
  }
  // 同一个名字不能既是文件又是别的文件的目录：投影时 mkdir 会撞上已写好的文件；同样按折叠后的键比较
  for (const path of paths) {
    for (const other of paths) {
      if (other !== path && other.startsWith(`${path}/`))
        return `资源文件路径「${path}」既是文件又是「${other}」的目录（不区分大小写）`;
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
export function defaultFilePath(file: { name: string; webkitRelativePath?: string }): string {
  const relative = file.webkitRelativePath ?? "";
  return relative !== "" ? relative : file.name;
}

/** base64 字符串对应的字节数（修订面板估算大小用，不解码整份内容） */
export function base64ByteLength(encoded: string): number {
  if (encoded === "") return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}
