import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ResolvedPort } from "@/lib/graph";
import { MAX_JSON_ARTIFACT_BYTES } from "@/lib/artifact-contract";
import { inspectArtifacts } from "./artifacts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-artifacts-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function port(artifactPath: string, kind: ResolvedPort["kind"] = "json"): ResolvedPort {
  return { name: "交付", objectTypeId: "t", objectTypeName: "结果", kind, artifactPath };
}

describe("产物文件边界", () => {
  it.each(["text", "file"] as const)("%s 普通文件无法打开时拒绝交付", async (kind) => {
    fs.writeFileSync(path.join(root, `不可读-${kind}`), "存在但不可读");
    // 模拟服务账户收到的 ACL / 权限拒绝，不依赖测试进程是不是 root。
    const open = vi
      .spyOn(fs.promises, "open")
      .mockRejectedValueOnce(Object.assign(new Error("禁止读取"), { code: "EACCES" }));
    try {
      const receipt = await inspectArtifacts([port(`不可读-${kind}`, kind)], root);
      expect(receipt.artifacts[0].issues).toEqual([
        { path: "$", expected: "可读取的产物文件", actual: "产物读取失败" },
      ]);
      expect(receipt.artifacts[0].file).toBeNull();
    } finally {
      open.mockRestore();
    }
  });

  it("文本与二进制只查文件存在，不强行解析 JSON", async () => {
    fs.writeFileSync(path.join(root, "文案.md"), "这不是 JSON");
    fs.writeFileSync(path.join(root, "文件.bin"), Buffer.from([0xff, 0]));
    const receipt = await inspectArtifacts(
      [port("文案.md", "text"), port("文件.bin", "file")],
      root,
    );
    expect(receipt.artifacts.map((item) => item.issues)).toEqual([[], []]);
    expect(receipt.artifacts.every((item) => item.file?.kind === "file")).toBe(true);
  });

  it("不存在、目录与指向区外的符号链接均不能成为产物", async () => {
    fs.mkdirSync(path.join(root, "目录"));
    fs.symlinkSync(os.tmpdir(), path.join(root, "外链"));
    const receipt = await inspectArtifacts([port("缺失.json"), port("目录"), port("外链")], root);
    expect(receipt.artifacts.map((item) => item.issues[0].actual)).toEqual([
      "声明的产物没有写出来",
      "产物不是文件",
      "产物指向工作区之外",
    ]);
    expect(receipt.artifacts.every((item) => item.file === null)).toBe(true);
  });

  it("无效 UTF-8 不被替换字符掩盖，仍保留原文件及散列", async () => {
    fs.writeFileSync(path.join(root, "编码.json"), Buffer.from([34, 0xff, 34]));
    const artifact = (await inspectArtifacts([port("编码.json")], root)).artifacts[0];
    expect(artifact.issues[0].actual).toBe("文件包含无效 UTF-8 字节");
    expect(artifact.file).not.toBeNull();
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("超大 JSON 流式计算散列后拒绝解析，内存不随文件增长", async () => {
    const file = path.join(root, "超大.json");
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, MAX_JSON_ARTIFACT_BYTES + 1);
    const artifact = (await inspectArtifacts([port("超大.json")], root)).artifacts[0];
    expect(artifact.issues[0].actual).toBe("文件超过解析上限");
    expect(artifact.sha256).toBe(
      createHash("sha256")
        .update(Buffer.alloc(MAX_JSON_ARTIFACT_BYTES + 1))
        .digest("hex"),
    );
  });
});
