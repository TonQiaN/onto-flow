/**
 * 磁盘占用统计（健康页与清理预览共用）。
 *
 * 只 stat 不读文件内容；data/runs 可能有成百上千个运行目录，因此用显式栈迭代
 * 而不是递归函数，并且遇到权限/竞态错误就跳过该项而不是整体抛错。
 * 独立成文件是为了让 cleanup.ts 不必经 health.ts 间接引入引擎模块。
 */
import fs from "node:fs";
import path from "node:path";

export interface DirStat {
  bytes: number;
  files: number;
  /** 调用方指定深度上的目录数；默认统计直接子目录。 */
  topDirs: number;
}

export function dirStat(root: string, countDirsAtDepth = 1): DirStat {
  let bytes = 0;
  let files = 0;
  let topDirs = 0;

  let top: fs.Dirent[];
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, topDirs: 0 };
  }

  const stack: Array<{ dir: string; depth: number }> = [];
  for (const entry of top) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (countDirsAtDepth === 1) topDirs += 1;
      stack.push({ dir: full, depth: 1 });
    } else if (entry.isFile()) {
      files += 1;
      bytes += safeSize(full);
    }
  }

  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // 只跟目录与普通文件，符号链接不跟（防环）
      if (entry.isDirectory()) {
        const childDepth = depth + 1;
        if (childDepth === countDirsAtDepth) topDirs += 1;
        stack.push({ dir: full, depth: childDepth });
      }
      else if (entry.isFile()) {
        files += 1;
        bytes += safeSize(full);
      }
    }
  }

  return { bytes, files, topDirs };
}

function safeSize(file: string): number {
  try {
    return fs.lstatSync(file).size;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
