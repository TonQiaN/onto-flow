import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FILE_INPUT_BYTES } from "@/lib/values";
import {
  claimsPdf,
  hasPdfSignature,
  MAX_PDF_DERIVED_BYTES,
  MAX_PDF_PAGES,
  MAX_PDF_TEXT_BYTES,
  preprocessPdfInput,
} from "./pdf-input";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-pdf-input-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("PDF 输入预处理", () => {
  it("以文件签名识别 PDF，不信任 MIME 或扩展名", () => {
    const dir = tempDir();
    const real = path.join(dir, "resume.bin");
    const fake = path.join(dir, "resume.pdf");
    fs.writeFileSync(real, "%PDF-1.7\n");
    fs.writeFileSync(fake, "not a pdf");

    expect(hasPdfSignature(real)).toBe(true);
    expect(hasPdfSignature(fake)).toBe(false);
    expect(claimsPdf("resume.pdf", "application/octet-stream")).toBe(true);
    expect(claimsPdf("resume.bin", "application/pdf")).toBe(true);
  });

  it("抽文本层并按页码顺序返回全部页面图", async () => {
    const dir = tempDir();
    const source = path.join(dir, "resume.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nfixture");
    const calls: Array<{ tool: string; args: string[] }> = [];

    const result = await preprocessPdfInput(source, output, {
      runTool: (tool, args) => {
        calls.push({ tool, args });
        if (tool === "pdfinfo") return "Pages:          2\n";
        if (tool === "pdftotext") return "fixture text\n";
        if (tool === "pdftoppm") fs.writeFileSync(`${args.at(-1)!}.png`, "page");
        return "";
      },
    });

    expect(calls.map((call) => call.tool)).toEqual([
      "pdfinfo",
      "pdftotext",
      "pdftoppm",
      "pdftoppm",
    ]);
    expect(result.pageCount).toBe(2);
    expect(result.textPath).toBe(path.join(output, "text-layer.txt"));
    expect(result.pageImagePaths.map((file) => path.basename(file))).toEqual([
      "page-1.png",
      "page-2.png",
    ]);
  });

  it("在栅格化前拒绝超过上限的 PDF", async () => {
    const dir = tempDir();
    const source = path.join(dir, "resume.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nfixture");
    const calls: string[] = [];

    await expect(
      preprocessPdfInput(source, output, {
        runTool: (tool) => {
          calls.push(tool);
          return `Pages: ${MAX_PDF_PAGES + 1}\n`;
        },
      }),
    ).rejects.toThrow(`超过单次最多 ${MAX_PDF_PAGES} 页`);
    expect(calls).toEqual(["pdfinfo"]);
  });

  it("在启动 Poppler 前拒绝超过 32 MiB 的原文件", async () => {
    const dir = tempDir();
    const source = path.join(dir, "oversized.pdf");
    const output = path.join(dir, "derived");
    fs.writeFileSync(source, "%PDF-1.7\n");
    fs.truncateSync(source, MAX_FILE_INPUT_BYTES + 1);
    const tool = () => "";

    await expect(preprocessPdfInput(source, output, { runTool: tool })).rejects.toThrow(
      "PDF 大小超过 32 MiB",
    );
    expect(fs.existsSync(output)).toBe(false);
  });

  it("文本层超过 16 MiB 时删除派生目录且不再栅格化", async () => {
    const dir = tempDir();
    const source = path.join(dir, "large-text.pdf");
    const output = path.join(dir, "derived");
    fs.writeFileSync(source, "%PDF-1.7\nfixture");
    const calls: string[] = [];

    await expect(
      preprocessPdfInput(source, output, {
        runTool: (tool) => {
          calls.push(tool);
          if (tool === "pdfinfo") return "Pages: 1\n";
          if (tool === "pdftotext") return "x".repeat(MAX_PDF_TEXT_BYTES + 1);
          return "";
        },
      }),
    ).rejects.toThrow("PDF 文本层超过 16 MiB");
    expect(calls).toEqual(["pdfinfo", "pdftotext"]);
    expect(fs.existsSync(output)).toBe(false);
  });

  it("扫描件没有文本层时仍保留全部页面图", async () => {
    const dir = tempDir();
    const source = path.join(dir, "scan.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nscan fixture");

    const result = await preprocessPdfInput(source, output, {
      runTool: (tool, args) => {
        if (tool === "pdfinfo") return "Pages: 1\n";
        if (tool === "pdftotext") return "";
        if (tool === "pdftoppm") fs.writeFileSync(`${args.at(-1)!}.png`, "scan page");
        return "";
      },
    });

    expect(fs.readFileSync(result.textPath, "utf8")).toBe("");
    expect(result.pageImagePaths).toHaveLength(1);
  });

  it("页面图缺失时失败，不把残缺输入交给模型", async () => {
    const dir = tempDir();
    const source = path.join(dir, "resume.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nfixture");

    await expect(
      preprocessPdfInput(source, output, {
        runTool: (tool, args) => {
          if (tool === "pdfinfo") return "Pages: 2\n";
          if (tool === "pdftotext") return "";
          if (tool === "pdftoppm" && args.includes("1")) {
            fs.writeFileSync(`${args.at(-1)!}.png`, "page 1");
          }
          return "";
        },
      }),
    ).rejects.toThrow("只生成 1/2 张页面图");
  });

  it("派生页面超过总量上限时删除半成品", async () => {
    const dir = tempDir();
    const source = path.join(dir, "large.pdf");
    const output = path.join(dir, "derived");
    fs.writeFileSync(source, "%PDF-1.7\nfixture");

    await expect(
      preprocessPdfInput(source, output, {
        runTool: (tool, args) => {
          if (tool === "pdfinfo") return "Pages: 1\n";
          if (tool === "pdftotext") return "";
          fs.writeFileSync(`${args.at(-1)!}.png`, "x");
          fs.truncateSync(`${args.at(-1)!}.png`, MAX_PDF_DERIVED_BYTES + 1);
          return "";
        },
      }),
    ).rejects.toThrow("派生文件合计超过");
    expect(fs.existsSync(output)).toBe(false);
  });

  it("取消信号传给正在执行的工具并删除半成品", async () => {
    const dir = tempDir();
    const source = path.join(dir, "cancel.pdf");
    const output = path.join(dir, "derived");
    fs.writeFileSync(source, "%PDF-1.7\nfixture");
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const pending = preprocessPdfInput(source, output, {
      signal: controller.signal,
      runTool: (tool, _args, signal) => {
        if (tool === "pdfinfo") return "Pages: 1\n";
        started?.();
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("已由信号取消")), {
            once: true,
          });
        });
      },
    });
    await toolStarted;
    controller.abort();

    await expect(pending).rejects.toThrow("已由信号取消");
    expect(fs.existsSync(output)).toBe(false);
  });
});
