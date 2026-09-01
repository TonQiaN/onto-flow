import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPdfPages } from "./resume-pdf-inspection";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-resume-pdf-"));
  roots.push(root);
  return root;
}

function writePage(root: string, nodeId: string, relativePath: string, content = "png"): void {
  const target = path.join(root, "inputs", nodeId, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe("简历 PDF 全页验收", () => {
  it("按输入节点隔离，并要求 1 到 pdfinfo 页数全部存在且非空", () => {
    const root = workspace();
    writePage(root, "job-node", "derived/pages/page-1.png");
    writePage(root, "job-node", "derived/pages/page-3.png");
    writePage(root, "resume-node", "page-2.png");

    expect(inspectPdfPages(root, "job-node", 3)).toEqual({
      expectedPages: 3,
      presentPages: [1, 3],
      missingPages: [2],
      complete: false,
    });
  });

  it("忽略空页面、裁剪图和另一份 PDF 的页面", () => {
    const root = workspace();
    writePage(root, "resume-node", "page-1.png");
    writePage(root, "resume-node", "page-2.png", "");
    writePage(root, "resume-node", "crop-2.png");
    writePage(root, "job-node", "page-2.png");

    expect(inspectPdfPages(root, "resume-node", 2)).toMatchObject({
      presentPages: [1],
      missingPages: [2],
      complete: false,
    });
  });

  it("每一页都有非空页面图时通过", () => {
    const root = workspace();
    writePage(root, "resume-node", "page-1.png");
    writePage(root, "resume-node", "nested/page-2.png");

    expect(inspectPdfPages(root, "resume-node", 2).complete).toBe(true);
  });
});
