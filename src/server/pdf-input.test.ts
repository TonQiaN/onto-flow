import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimsPdf,
  hasPdfSignature,
  MAX_PDF_PAGES,
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

  it("抽文本层并按页码顺序返回全部页面图", () => {
    const dir = tempDir();
    const source = path.join(dir, "resume.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nfixture");
    const calls: Array<{ tool: string; args: string[] }> = [];

    const result = preprocessPdfInput(source, output, (tool, args) => {
      calls.push({ tool, args });
      if (tool === "pdfinfo") return "Pages:          2\n";
      if (tool === "pdftotext") fs.writeFileSync(args.at(-1)!, "fixture text\n");
      if (tool === "pdftoppm") {
        const prefix = args.at(-1)!;
        fs.writeFileSync(`${prefix}-2.png`, "page 2");
        fs.writeFileSync(`${prefix}-1.png`, "page 1");
      }
      return "";
    });

    expect(calls.map((call) => call.tool)).toEqual(["pdfinfo", "pdftotext", "pdftoppm"]);
    expect(result.pageCount).toBe(2);
    expect(result.textPath).toBe(path.join(output, "text-layer.txt"));
    expect(result.pageImagePaths.map((file) => path.basename(file))).toEqual([
      "page-1.png",
      "page-2.png",
    ]);
  });

  it("在栅格化前拒绝超过上限的 PDF", () => {
    const dir = tempDir();
    const source = path.join(dir, "resume.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nfixture");
    const calls: string[] = [];

    expect(() =>
      preprocessPdfInput(source, output, (tool) => {
        calls.push(tool);
        return `Pages: ${MAX_PDF_PAGES + 1}\n`;
      }),
    ).toThrow(`超过单次最多 ${MAX_PDF_PAGES} 页`);
    expect(calls).toEqual(["pdfinfo"]);
  });

  it("扫描件没有文本层时仍保留全部页面图", () => {
    const dir = tempDir();
    const source = path.join(dir, "scan.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nscan fixture");

    const result = preprocessPdfInput(source, output, (tool, args) => {
      if (tool === "pdfinfo") return "Pages: 1\n";
      if (tool === "pdftotext") fs.writeFileSync(args.at(-1)!, "");
      if (tool === "pdftoppm") fs.writeFileSync(`${args.at(-1)!}-1.png`, "scan page");
      return "";
    });

    expect(fs.readFileSync(result.textPath, "utf8")).toBe("");
    expect(result.pageImagePaths).toHaveLength(1);
  });

  it("页面图缺失时失败，不把残缺输入交给模型", () => {
    const dir = tempDir();
    const source = path.join(dir, "resume.pdf");
    const output = path.join(dir, "derived");
    fs.mkdirSync(output);
    fs.writeFileSync(source, "%PDF-1.7\nfixture");

    expect(() =>
      preprocessPdfInput(source, output, (tool, args) => {
        if (tool === "pdfinfo") return "Pages: 2\n";
        if (tool === "pdftotext") fs.writeFileSync(args.at(-1)!, "");
        if (tool === "pdftoppm") fs.writeFileSync(`${args.at(-1)!}-1.png`, "page 1");
        return "";
      }),
    ).toThrow("只生成 1/2 张页面图");
  });
});
