import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ResolvedPort } from "@/lib/graph";
import { MAX_JSON_ARTIFACT_BYTES } from "@/lib/artifact-contract";
import { inspectArtifacts } from "./artifacts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-artifacts-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function port(artifactPath: string, kind: ResolvedPort["kind"] = "json"): ResolvedPort {
  return { name: "交付", objectTypeId: "t", objectTypeName: "结果", kind, artifactPath };
}

describe("产物文件边界", () => {
  it("文本与二进制只查文件存在，不强行解析 JSON", () => {
    fs.writeFileSync(path.join(root, "文案.md"), "这不是 JSON");
    fs.writeFileSync(path.join(root, "文件.bin"), Buffer.from([0xff, 0]));
    const receipt = inspectArtifacts([port("文案.md", "text"), port("文件.bin", "file")], root);
    expect(receipt.artifacts.map((item) => item.issues)).toEqual([[], []]);
    expect(receipt.artifacts.every((item) => item.file?.kind === "file")).toBe(true);
  });

  it("不存在、目录与指向区外的符号链接均不能成为产物", () => {
    fs.mkdirSync(path.join(root, "目录"));
    fs.symlinkSync(os.tmpdir(), path.join(root, "外链"));
    const receipt = inspectArtifacts([port("缺失.json"), port("目录"), port("外链")], root);
    expect(receipt.artifacts.map((item) => item.issues[0].actual)).toEqual([
      "声明的产物没有写出来",
      "产物不是文件",
      "产物指向工作区之外",
    ]);
    expect(receipt.artifacts.every((item) => item.file === null)).toBe(true);
  });

  it("无效 UTF-8 不被替换字符掩盖，仍保留原文件及散列", () => {
    fs.writeFileSync(path.join(root, "编码.json"), Buffer.from([34, 0xff, 34]));
    const artifact = inspectArtifacts([port("编码.json")], root).artifacts[0];
    expect(artifact.issues[0].actual).toBe("文件包含无效 UTF-8 字节");
    expect(artifact.file).not.toBeNull();
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("超大 JSON 在读取和解析前拒绝", () => {
    const file = path.join(root, "超大.json");
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, MAX_JSON_ARTIFACT_BYTES + 1);
    const artifact = inspectArtifacts([port("超大.json")], root).artifacts[0];
    expect(artifact.issues[0].actual).toBe("文件超过解析上限");
    expect(artifact.sha256).toBeNull();
  });
});
