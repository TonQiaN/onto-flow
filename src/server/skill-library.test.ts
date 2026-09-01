/** 技能投影测试：临时文件必须留在技能目录之外，避免并发摘要把它纳入内容。 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/ontoflow-skill-library-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

vi.mock("@/db", () => ({ db: {}, skills: {} }));
vi.mock("@/server/fs-safety", () => ({ DATA_DIR: testPaths.dataDir }));

const {
  materializeSkill,
  releaseSkillProjections,
  removeSkill,
  retainSkillProjections,
  skillSlug,
  SKILL_LIBRARY_DIR,
} = await import("./skill-library");

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

  it("删除已被运行持有的 Skill 时保留投影，最后一个运行收束后才删除", () => {
    const skill = {
      id: "held-skill",
      name: "运行持有技能",
      description: "检查删除竞态",
      content: "保持可读。",
    };
    const file = path.join(SKILL_LIBRARY_DIR, skillSlug(skill), "SKILL.md");
    materializeSkill(skill);
    retainSkillProjections("run-held-1", [skill]);
    retainSkillProjections("run-held-2", [skill]);

    removeSkill(skill);

    expect(fs.readFileSync(file, "utf8")).toContain("保持可读");
    expect(() => retainSkillProjections("run-after-delete", [skill])).toThrow(
      "已删除，不能用于本次运行",
    );
    releaseSkillProjections("run-held-1", [skill]);
    expect(fs.existsSync(file)).toBe(true);
    releaseSkillProjections("run-held-2", [skill]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("受理检查中任一投影缺失时回滚已经取得的持有", () => {
    const present = {
      id: "rollback-present-skill",
      name: "可读技能",
      description: "用于验证回滚",
      content: "正文",
    };
    const missing = {
      id: "rollback-missing-skill",
      name: "缺失技能",
      description: "没有投影",
      content: "不会写入",
    };
    const presentFile = path.join(SKILL_LIBRARY_DIR, skillSlug(present), "SKILL.md");
    materializeSkill(present);

    expect(() => retainSkillProjections("run-rollback", [present, missing])).toThrow(
      "技能「缺失技能」的磁盘投影不存在或不可读",
    );

    removeSkill(present);
    expect(fs.existsSync(presentFile)).toBe(false);
  });

  it("同 id 的修订恢复会取消延迟删除，不让旧运行收束时删掉新投影", () => {
    const before = {
      id: "restored-held-skill",
      name: "待恢复技能",
      description: "旧版本",
      content: "旧正文",
    };
    const restored = { ...before, description: "恢复版本", content: "恢复正文" };
    const file = path.join(SKILL_LIBRARY_DIR, skillSlug(before), "SKILL.md");
    materializeSkill(before);
    retainSkillProjections("run-before-restore", [before]);
    removeSkill(before);

    materializeSkill(restored);
    releaseSkillProjections("run-before-restore", [before]);

    expect(fs.readFileSync(file, "utf8")).toContain("恢复正文");
    removeSkill(restored);
  });
});
