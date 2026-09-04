/** Skill 写入测试：技能是目录——资源文件的路径与大小在写入口挡住，写库与投影同步。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_FILE_MAX_COUNT } from "@/lib/skill-files";
import { createTestDb, resetTestDb } from "./test-db";

const materializeSkill = vi.hoisted(() => vi.fn());
vi.mock("@/server/skill-library", () => ({ materializeSkill }));

const { sqlite } = await createTestDb();
const { createSkill, loadSkillDto, writeSkill } = await import("./skill");

beforeEach(() => {
  resetTestDb(sqlite);
  materializeSkill.mockClear();
});

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("Skill 资源文件校验", () => {
  it.each([
    [{ path: "../escape.md", contentBase64: "" }, ".."],
    [{ path: "/abs.md", contentBase64: "" }, "绝对路径"],
    [{ path: "a//b.md", contentBase64: "" }, "空段"],
    [{ path: "a\\b.md", contentBase64: "" }, "只能用 /"],
    [{ path: "nul\u0000.md", contentBase64: "" }, "控制字符"],
    [{ path: "x".repeat(201), contentBase64: "" }, "200"],
    [{ path: "SKILL.md", contentBase64: "" }, "SKILL.md"],
    [{ path: "ok.md", contentBase64: "not base64!" }, "base64"],
    [{ path: "ok.md" }, "contentBase64"],
  ])("拒绝非法资源文件 %j", (file, fragment) => {
    const result = createSkill({ name: "校验", files: [file] });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining(fragment),
    });
    expect(materializeSkill).not.toHaveBeenCalled();
  });

  it("拒绝单文件超过 1 MiB", () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 1).toString("base64");
    const result = createSkill({
      name: "大文件",
      files: [{ path: "big.bin", contentBase64: big }],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("1 MiB"),
    });
  });

  it("拒绝超过 32 个文件", () => {
    const files = Array.from({ length: SKILL_FILE_MAX_COUNT + 1 }, (_, i) => ({
      path: `f${i}.md`,
      contentBase64: "",
    }));
    const result = createSkill({ name: "太多文件", files });
    expect(result).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("32") });
  });

  it("拒绝重复路径与「既是文件又是目录」", () => {
    expect(
      createSkill({
        name: "重复",
        files: [
          { path: "a.md", contentBase64: "" },
          { path: "a.md", contentBase64: "" },
        ],
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("重复") });
    expect(
      createSkill({
        name: "冲突",
        files: [
          { path: "ref", contentBase64: "" },
          { path: "ref/a.md", contentBase64: "" },
        ],
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("既是文件又是") });
  });

  it("NFC 与 NFD 拼出的同一个名字算重复：APFS 对 Unicode 正规化同样不敏感", () => {
    expect(
      createSkill({
        name: "正规化重复",
        files: [
          { path: "café.md", contentBase64: "" },
          { path: "café.md", contentBase64: "" },
        ],
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("Unicode 正规化") });
  });

  it("重复与文件/目录冲突按不区分大小写判断：macOS 默认文件系统会把它们投到同一处", () => {
    expect(
      createSkill({
        name: "大小写重复",
        files: [
          { path: "Readme.md", contentBase64: "" },
          { path: "readme.md", contentBase64: "" },
        ],
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("不区分大小写") });
    expect(
      createSkill({
        name: "大小写目录冲突",
        files: [
          { path: "docs", contentBase64: "" },
          { path: "DOCS/x.md", contentBase64: "" },
        ],
      }),
    ).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("既是文件又是") });
  });
});

describe("Skill 写入", () => {
  it("新建写 skill_files、投影收到文件、DTO 与修订载荷都带 files", () => {
    const created = createSkill({
      name: "评分范本",
      description: "打分时参考",
      content: "按范本打分。",
      files: [
        { path: "scripts/check.py", contentBase64: b64("print('ok')") },
        { path: "references/rubric.md", contentBase64: b64("# 评分表") },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.data.files).toEqual([
      {
        path: "references/rubric.md",
        contentBase64: b64("# 评分表"),
        size: Buffer.byteLength("# 评分表"),
      },
      { path: "scripts/check.py", contentBase64: b64("print('ok')"), size: 11 },
    ]);
    expect(
      sqlite
        .prepare("select path, size from skill_files where skill_id = ? order by path")
        .all(created.data.id),
    ).toEqual([
      { path: "references/rubric.md", size: Buffer.byteLength("# 评分表") },
      { path: "scripts/check.py", size: 11 },
    ]);
    expect(materializeSkill).toHaveBeenCalledTimes(1);
    const [row, files] = materializeSkill.mock.calls[0] as [
      { id: string },
      Array<{ path: string; content: Buffer }>,
    ];
    expect(row.id).toBe(created.data.id);
    expect(files.map((f) => [f.path, f.content.toString("utf8")])).toEqual([
      ["scripts/check.py", "print('ok')"],
      ["references/rubric.md", "# 评分表"],
    ]);

    const revision = sqlite
      .prepare("select payload from revisions where entity_kind = 'skill' and entity_id = ?")
      .get(created.data.id) as { payload: string };
    expect(JSON.parse(revision.payload)).toEqual({
      name: "评分范本",
      description: "打分时参考",
      content: "按范本打分。",
      files: [
        { path: "scripts/check.py", contentBase64: b64("print('ok')") },
        { path: "references/rubric.md", contentBase64: b64("# 评分表") },
      ],
    });
  });

  it("更新整体替换资源文件；不发 files 即清空", () => {
    const created = createSkill({
      name: "替换",
      files: [{ path: "old.md", contentBase64: b64("旧") }],
    });
    if (!created.ok) throw new Error(created.error);

    const updated = writeSkill(created.data.id, {
      name: "替换",
      content: "新正文",
      files: [{ path: "new.md", contentBase64: b64("新") }],
    });
    expect(updated.ok).toBe(true);
    expect(loadSkillDto(created.data.id)?.files.map((f) => f.path)).toEqual(["new.md"]);

    const cleared = writeSkill(created.data.id, { name: "替换", content: "新正文" });
    expect(cleared.ok).toBe(true);
    expect(loadSkillDto(created.data.id)?.files).toEqual([]);
    expect(sqlite.prepare("select count(*) as n from skill_files").get()).toEqual({ n: 0 });
  });
});
