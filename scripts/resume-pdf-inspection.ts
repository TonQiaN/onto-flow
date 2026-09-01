import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface PdfPageInspection {
  expectedPages: number;
  presentPages: number[];
  missingPages: number[];
  complete: boolean;
}

/** pdfinfo 的页数是验收基准；解析不到正整数时不能把 PDF 当成已完整处理。 */
export function readPdfPageCount(absolutePath: string): number {
  const output = execFileSync("pdfinfo", [absolutePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const matched = /^Pages:\s+(\d+)\s*$/im.exec(output);
  const pages = matched ? Number(matched[1]) : 0;
  if (!Number.isSafeInteger(pages) || pages <= 0) {
    throw new Error("pdfinfo 没有返回有效页数");
  }
  return pages;
}

function pageImageNumbers(root: string): number[] {
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) return [];
  const pages = new Set<number>();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      const matched = /^page-(\d+)\.png$/i.exec(entry.name);
      if (!matched) continue;
      const page = Number(matched[1]);
      const stat = fs.lstatSync(absolutePath);
      if (Number.isSafeInteger(page) && page > 0 && stat.isFile() && stat.size > 0) {
        pages.add(page);
      }
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** 每份 PDF 只认自己输入节点目录里的非空 page-N.png，不能拿另一份 PDF 的页面凑数。 */
export function inspectPdfPages(
  workspaceDir: string,
  inputNodeId: string,
  expectedPages: number,
): PdfPageInspection {
  const presentPages = pageImageNumbers(path.join(workspaceDir, "inputs", inputNodeId));
  const present = new Set(presentPages);
  const missingPages = Array.from(
    { length: expectedPages },
    (_value, index) => index + 1,
  ).filter((page) => !present.has(page));
  return {
    expectedPages,
    presentPages,
    missingPages,
    complete: missingPages.length === 0,
  };
}
