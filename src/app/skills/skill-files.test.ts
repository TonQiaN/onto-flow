import { describe, expect, it } from "vitest";
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_MAX_COUNT,
  skillFilePathProblem,
} from "@/lib/skill-files";
import { defaultFilePath, formatBytes, skillFilesProblem } from "./skill-files";

describe("资源文件路径校验（与写入口同一套规则）", () => {
  it("合法的相对路径通过", () => {
    expect(skillFilePathProblem("references/guide.md")).toBeNull();
    expect(skillFilePathProblem("scripts/run.py")).toBeNull();
    expect(skillFilePathProblem("附录.md")).toBeNull();
  });

  it("绝对路径、反斜杠、空段与 .. 都被拒绝", () => {
    expect(skillFilePathProblem("/etc/passwd")).toMatch(/绝对路径/);
    expect(skillFilePathProblem("a\\b.md")).toMatch(/只能用 \/ 分段/);
    expect(skillFilePathProblem("a//b.md")).toMatch(/空段/);
    expect(skillFilePathProblem("../x.md")).toMatch(/\.\./);
    expect(skillFilePathProblem("a/./b.md")).toMatch(/空段、\. 或 \.\./);
    expect(skillFilePathProblem("")).toMatch(/不能为空/);
  });

  it("控制字符与超长路径被拒绝", () => {
    expect(skillFilePathProblem("a\u0000b")).toMatch(/控制字符/);
    expect(skillFilePathProblem("x".repeat(201))).toMatch(/超过 200 个字符/);
  });

  it("SKILL.md 不能作为资源文件、也不能作为根下目录名（不区分大小写）", () => {
    expect(skillFilePathProblem("SKILL.md")).toMatch(/SKILL\.md 由正文生成/);
    expect(skillFilePathProblem("skill.MD")).toMatch(/SKILL\.md 由正文生成/);
    expect(skillFilePathProblem("SKILL.md/x.md")).toMatch(/也不能作为目录名/);
    // 子目录下的 SKILL.md 是普通文件
    expect(skillFilePathProblem("sub/SKILL.md")).toBeNull();
  });

  it("重复与文件/目录冲突折叠大小写与 Unicode 正规化，与写入口同一规则", () => {
    expect(
      skillFilesProblem([
        { path: "Readme.md", size: 1 },
        { path: "readme.md", size: 1 },
      ]),
    ).toMatch(/重复（不区分大小写与 Unicode 正规化）/);
    expect(
      skillFilesProblem([
        { path: "café.md", size: 1 },
        { path: "café.md", size: 1 },
      ]),
    ).toMatch(/重复/);
    expect(
      skillFilesProblem([
        { path: "docs", size: 1 },
        { path: "DOCS/x.md", size: 1 },
      ]),
    ).toMatch(/既是文件又是/);
  });
});

describe("整份清单校验", () => {
  it("数量超限、重复路径、超大文件与文件/目录冲突各报一句", () => {
    const many = Array.from({ length: SKILL_FILE_MAX_COUNT + 1 }, (_, i) => ({
      path: `f${i}.md`,
      size: 1,
    }));
    expect(skillFilesProblem(many)).toMatch(/最多 32 个/);
    expect(
      skillFilesProblem([
        { path: "a.md", size: 1 },
        { path: "a.md", size: 1 },
      ]),
    ).toMatch(/重复/);
    expect(skillFilesProblem([{ path: "big.bin", size: SKILL_FILE_MAX_BYTES + 1 }])).toMatch(
      /超过 1 MiB/,
    );
    expect(
      skillFilesProblem([
        { path: "a", size: 1 },
        { path: "a/b.md", size: 1 },
      ]),
    ).toMatch(/既是文件又是/);
    expect(
      skillFilesProblem([
        { path: "a.md", size: 1 },
        { path: "b/c.md", size: SKILL_FILE_MAX_BYTES },
      ]),
    ).toBeNull();
  });
});

describe("小工具", () => {
  it("目录上传保留相对路径，单文件用文件名", () => {
    expect(defaultFilePath({ name: "x.md", webkitRelativePath: "" })).toBe("x.md");
    expect(defaultFilePath({ name: "x.md", webkitRelativePath: "docs/x.md" })).toBe("docs/x.md");
  });

  it("字节数按 B / KiB / MiB 显示", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.50 MiB");
  });
});
