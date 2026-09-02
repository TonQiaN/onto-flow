/** 启动重建：旧式真实目录换成链接、临时链接与孤儿版本清掉、悬空链接重指、库里没有的技能目录删掉。 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./writers/test-db";

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/ontoflow-skill-rebuild-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

vi.mock("@/server/fs-safety", () => ({ DATA_DIR: testPaths.dataDir }));

const { db } = await createTestDb();
const { skillFiles, skills } = await import("@/db/schema");
const { rebuildSkillLibrary, releaseSkillProjections, retainSkillProjections, skillSlug, SKILL_LIBRARY_DIR } =
  await import("./skill-library");

afterAll(() => {
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
});

describe("启动重建技能投影", () => {
  it("旧式真实目录换成链接、悬空链接重指、临时链接与孤儿版本清掉、库里没有的技能目录删掉", () => {
    const legacy = { id: "rebuild-legacy", name: "旧式目录技能", description: "d1", content: "库里的正文一" };
    const dangling = { id: "rebuild-dangling", name: "悬空链接技能", description: "d2", content: "库里的正文二" };
    db.insert(skills).values([legacy, dangling]).run();
    db.insert(skillFiles)
      .values({ skillId: legacy.id, path: "refs/a.md", content: Buffer.from("A"), size: 1 })
      .run();

    const root = SKILL_LIBRARY_DIR;
    const versions = path.join(root, ".versions");
    fs.mkdirSync(versions, { recursive: true });
    // 升级前的投影：<slug> 是真实目录
    const legacyDir = path.join(root, skillSlug(legacy));
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), "旧投影", "utf8");
    // 版本目录被人手删过：链接悬空
    fs.symlinkSync(`.versions/${skillSlug(dangling)}-gone`, path.join(root, skillSlug(dangling)), "dir");
    // 上次进程中途倒下留下的孤儿版本与临时链接
    const orphan = path.join(versions, `${skillSlug(legacy)}-orphan`);
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, "SKILL.md"), "孤儿", "utf8");
    fs.symlinkSync(".versions/x", path.join(root, `.${skillSlug(legacy)}-stale.link.tmp`), "dir");
    // 库里已经没有的技能
    const stranger = `skill-${"0".repeat(20)}`;
    fs.mkdirSync(path.join(root, stranger));
    fs.writeFileSync(path.join(root, stranger, "SKILL.md"), "库里没有", "utf8");

    rebuildSkillLibrary();

    for (const skill of [legacy, dangling]) {
      const dir = path.join(root, skillSlug(skill));
      expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain(skill.content);
    }
    expect(fs.readFileSync(path.join(root, skillSlug(legacy), "refs", "a.md"), "utf8")).toBe("A");
    expect(fs.existsSync(path.join(root, stranger))).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".link.tmp"))).toEqual([]);
    const live = [legacy, dangling].map((skill) =>
      path.basename(fs.readlinkSync(path.join(root, skillSlug(skill)))),
    );
    expect(fs.readdirSync(versions).sort()).toEqual([...live].sort());
  });

  it("被已受理运行持有、库里已删的技能：重建不删它的链接与版本，最后一个持有者释放后才删", () => {
    const held = { id: "rebuild-held-deleted", name: "持有中已删技能", description: "d3", content: "持有中的正文" };
    db.insert(skills).values(held).run();
    rebuildSkillLibrary();
    retainSkillProjections("run-holding", [held]);
    db.delete(skills).where(eq(skills.id, held.id)).run();

    rebuildSkillLibrary();

    const dir = path.join(SKILL_LIBRARY_DIR, skillSlug(held));
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("持有中的正文");

    releaseSkillProjections("run-holding", [held]);
    expect(fs.existsSync(dir)).toBe(false);
    const versions = path.join(SKILL_LIBRARY_DIR, ".versions");
    expect(fs.readdirSync(versions).filter((name) => name.startsWith(skillSlug(held)))).toEqual([]);
  });
});
