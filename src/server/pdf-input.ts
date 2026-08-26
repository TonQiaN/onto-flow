/**
 * PDF 输入预处理：保留原文件，抽取文本层，并把每页栅格化为 PNG。
 *
 * 这一步属于输入节点的对象类型契约，不属于某个 Action。Action 只消费已经落在
 * 工作区里的派生文件；模型不会拿到 data/uploads 的宿主绝对路径。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_FILE_INPUT_BYTES } from "@/lib/values";

export const MAX_PDF_PAGES = 20;

export interface PdfPreprocessResult {
  pageCount: number;
  textPath: string;
  pageImagePaths: string[];
}

type PdfTool = "pdfinfo" | "pdftotext" | "pdftoppm";
type RunPdfTool = (tool: PdfTool, args: string[]) => string;

const PDF_HEADER = Buffer.from("%PDF-");

/** 文件内容才是 PDF 判断依据；multipart MIME 与扩展名都来自不可信输入。 */
export function hasPdfSignature(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(PDF_HEADER.length);
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    return bytes === header.length && header.equals(PDF_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

/** MIME/扩展名声称是 PDF 时，签名不对就响亮失败，不能把二进制垃圾交给模型。 */
export function claimsPdf(name: string, mime: string): boolean {
  return mime.toLowerCase() === "application/pdf" || path.extname(name).toLowerCase() === ".pdf";
}

function runPdfTool(tool: PdfTool, args: string[]): string {
  try {
    return execFileSync(tool, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error(`PDF 预处理缺少 ${tool}；请安装 Poppler 后重试`);
    }
    // 外部工具的 stderr 可能含本地路径；运行错误只保留稳定、可行动的工具名。
    throw new Error(`PDF 预处理失败（${tool}）`);
  }
}

function pageCountFromPdfInfo(output: string): number {
  const match = /^Pages:\s+(\d+)\s*$/m.exec(output);
  const count = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("PDF 预处理无法读取页数");
  }
  if (count > MAX_PDF_PAGES) {
    throw new Error(`PDF 共 ${count} 页，超过单次最多 ${MAX_PDF_PAGES} 页`);
  }
  return count;
}

function pageNumber(fileName: string): number {
  const match = /-(\d+)\.png$/i.exec(fileName);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * 预处理一份已经确认带 PDF 签名的文件。runTool 是无外部进程单测的窄缝；生产
 * 永远使用上面的 execFileSync 白名单，用户输入不会成为命令或参数名。
 */
export function preprocessPdfInput(
  sourcePath: string,
  destinationDir: string,
  runTool: RunPdfTool = runPdfTool,
): PdfPreprocessResult {
  const bytes = fs.statSync(sourcePath).size;
  if (bytes > MAX_FILE_INPUT_BYTES) {
    throw new Error(`PDF 大小超过 ${MAX_FILE_INPUT_BYTES / 1024 / 1024} MiB`);
  }
  if (!hasPdfSignature(sourcePath)) throw new Error("上传文件不是合法的 PDF");

  const pageCount = pageCountFromPdfInfo(runTool("pdfinfo", [sourcePath]));
  const textPath = path.join(destinationDir, "text-layer.txt");
  const pagesDir = path.join(destinationDir, "pages");
  fs.mkdirSync(pagesDir, { recursive: true });

  runTool("pdftotext", ["-layout", "-enc", "UTF-8", sourcePath, textPath]);
  runTool("pdftoppm", [
    "-png",
    "-scale-to",
    "2048",
    "-f",
    "1",
    "-l",
    String(pageCount),
    sourcePath,
    path.join(pagesDir, "page"),
  ]);

  const pageImagePaths = fs
    .readdirSync(pagesDir)
    .filter((name) => /^page-\d+\.png$/i.test(name))
    .sort((a, b) => pageNumber(a) - pageNumber(b))
    .map((name) => path.join(pagesDir, name));
  if (pageImagePaths.length !== pageCount) {
    throw new Error(`PDF 预处理只生成 ${pageImagePaths.length}/${pageCount} 张页面图`);
  }
  if (!fs.existsSync(textPath)) throw new Error("PDF 预处理没有生成文本层文件");

  return { pageCount, textPath, pageImagePaths };
}
