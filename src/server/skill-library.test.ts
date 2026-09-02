/** 技能投影测试：半成品只在 .versions/ 下、换链接不换路径；旧版本随持有释放而删；旧式真实目录被换成链接。 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/ontoflow-skill-library-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

vi.mock("@/db", () => ({ db: {}, skills: {}, skillFiles: {} }));
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
  it("全部文件写在 .versions/ 下的版本目录里，<slug> 是指向它的链接", () => {
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
      materializeSkill(skill, [{ path: "scripts/check.py", content: Buffer.from("print('ok')") }]);
    } finally {
      spy.mockRestore();
    }

    const slug = skillSlug(skill);
    const dir = path.join(SKILL_LIBRARY_DIR, slug);
    expect(written).toHaveLength(2);
    for (const file of written) {
      // 半成品全部落在 <root>/.versions/<slug>-<uuid>/ 之下，链接换过去之前 <slug> 下看不到
      const segments = path.relative(SKILL_LIBRARY_DIR, file).split(path.sep);
      expect(segments[0]).toBe(".versions");
      expect(segments[1]).toMatch(new RegExp(`^${slug}-`));
    }
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(["SKILL.md", "scripts"]);
    expect(fs.readFileSync(path.join(dir, "scripts", "check.py"), "utf8")).toBe("print('ok')");
    expect(fs.readdirSync(SKILL_LIBRARY_DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("重写只换链接不换路径：旧版本无人持有时立即删，被持有时等释放后再删", () => {
    const skill = {
      id: "version-switch-skill",
      name: "换版本技能",
      description: "验证链接切换",
      content: "第一版",
    };
    const slug = skillSlug(skill);
    const dir = path.join(SKILL_LIBRARY_DIR, slug);
    const versionsDir = path.join(SKILL_LIBRARY_DIR, ".versions");
    const versionsOf = () => fs.readdirSync(versionsDir).filter((name) => name.startsWith(`${slug}-`));

    materializeSkill(skill);
    const first = path.basename(fs.readlinkSync(dir));
    materializeSkill({ ...skill, content: "第二版" });
    const second = path.basename(fs.readlinkSync(dir));
    expect(second).not.toBe(first);
    // 无人持有：旧版本目录立即消失，只剩当前版本
    expect(versionsOf()).toEqual([second]);
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("第二版");

    retainSkillProjections("run-holding", [skill]);
    materializeSkill({ ...skill, content: "第三版" });
    const third = path.basename(fs.readlinkSync(dir));
    // 被持有：换下的第二版留着，等运行收束
    expect(versionsOf().sort()).toEqual([second, third].sort());
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("第三版");
    releaseSkillProjections("run-holding", [skill]);
    expect(versionsOf()).toEqual([third]);
    removeSkill(skill);
    expect(versionsOf()).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("旧式的真实目录被换成链接，内容以库为准", () => {
    const skill = {
      id: "legacy-dir-skill",
      name: "旧式目录技能",
      description: "升级前的投影",
      content: "新投影",
    };
    const dir = path.join(SKILL_LIBRARY_DIR, skillSlug(skill));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "旧投影", "utf8");

    materializeSkill(skill);

    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("新投影");
    removeSkill(skill);
  });

  it("重写时不再声明的资源文件从投影里消失", () => {
    const skill = {
      id: "files-replaced-skill",
      name: "资源文件技能",
      description: "参考资料",
      content: "正文",
    };
    const dir = path.join(SKILL_LIBRARY_DIR, skillSlug(skill));
    materializeSkill(skill, [
      { path: "references/a.md", content: Buffer.from("A") },
      { path: "references/b.md", content: Buffer.from("B") },
    ]);
    expect(fs.readdirSync(path.join(dir, "references")).sort()).toEqual(["a.md", "b.md"]);

    materializeSkill(skill, [{ path: "references/b.md", content: Buffer.from("B2") }]);
    expect(fs.readdirSync(path.join(dir, "references"))).toEqual(["b.md"]);
    expect(fs.readFileSync(path.join(dir, "references", "b.md"), "utf8")).toBe("B2");

    materializeSkill(skill);
    expect(fs.readdirSync(dir)).toEqual(["SKILL.md"]);
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
