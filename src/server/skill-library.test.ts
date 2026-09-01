/** 技能投影测试：临时文件必须留在技能目录之外，避免并发摘要把它纳入内容。 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/ontoflow-skill-library-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

vi.mock("@/db", () => ({ db: {}, skills: {} }));
vi.mock("@/server/fs-safety", () => ({ DATA_DIR: testPaths.dataDir }));

const { materializeSkill, skillSlug, SKILL_LIBRARY_DIR } = await import("./skill-library");

afterAll(() => {
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
});

describe("技能磁盘投影", () => {
  it("在库根写唯一临时文件，再原子替换技能目录内唯一的 SKILL.md", () => {
    const written: string[] = [];
    const original = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      written.push(String(file));
      return original(file, data, options as never);
    });
    const skill = {
      id: "12345678-skill",
      name: "验收技能",
      description: "检查产物",
      content: "按契约检查。",
    };

    try {
      materializeSkill(skill);
    } finally {
      spy.mockRestore();
    }

    const slug = skillSlug(skill);
    const dir = path.join(SKILL_LIBRARY_DIR, slug);
    const temp = written.find((file) => file.endsWith(".tmp"));
    expect(temp).toBeDefined();
    expect(path.dirname(temp!)).toBe(SKILL_LIBRARY_DIR);
    expect(path.dirname(temp!)).not.toBe(dir);
    expect(fs.readdirSync(dir)).toEqual(["SKILL.md"]);
    expect(fs.readdirSync(SKILL_LIBRARY_DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("改名沿用 id 稳定目录，已经建立的运行链接仍能读到新正文", () => {
    const before = {
      id: "rename-stable-skill",
      name: "旧技能名",
      description: "旧描述",
      content: "旧正文",
    };
    const after = {
      ...before,
      name: "新技能名",
      description: "新描述",
      content: "新正文",
    };
    expect(skillSlug(before)).toBe(skillSlug(after));

    materializeSkill(before);
    const runRoot = path.join(testPaths.dataDir, "run-link");
    fs.mkdirSync(runRoot, { recursive: true });
    const linked = path.join(runRoot, skillSlug(before));
    fs.symlinkSync(path.join(SKILL_LIBRARY_DIR, skillSlug(before)), linked, "dir");

    materializeSkill(after);

    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    const content = fs.readFileSync(path.join(linked, "SKILL.md"), "utf8");
    expect(content).toContain('description: "新技能名：新描述"');
    expect(content).toContain("新正文");
  });
});
