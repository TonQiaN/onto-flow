import { describe, expect, it } from "vitest";
import { isTextPreviewMime } from "./resume-artifact-inspection";

describe("简历验收产物预览分类", () => {
  it("Markdown 与 JSON 进入文本预览", () => {
    expect(isTextPreviewMime("text/markdown")).toBe(true);
    expect(isTextPreviewMime("application/json")).toBe(true);
    expect(isTextPreviewMime("application/problem+json")).toBe(true);
  });

  it("PDF 与未知二进制只做文件元数据验收", () => {
    expect(isTextPreviewMime("application/pdf")).toBe(false);
    expect(isTextPreviewMime("application/octet-stream")).toBe(false);
  });
});
