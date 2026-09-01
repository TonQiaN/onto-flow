/**
 * 全局技能库的磁盘投影：把 skills 表的行物化成 dsh 认得的技能目录。
 *
 * 数据库仍是唯一真相，磁盘是它的投影——每次写 Skill 就重写对应目录。
 * 运行工作区里的技能是指向这里的 symlink（ADR-0007），所以「活目录」指的就是
 * 本模块维护的这份投影：全局库改完，下一次运行即生效。
 *
 * 目录形态对齐上游 skill-filesystem：<root>/<slug>/SKILL.md，平铺 frontmatter
 * 必填 name 与 description。
 *
 * 目录名与 frontmatter 的 name 用的是**派生 slug**而不是库里的名字：上游的
 * 技能名必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/，而本仓库的实体名一律是中文
 * （见 AGENTS.md 的 Conventions）。中文名会被上游静默忽略——只在日志里留一行
 * warn，技能就此不出现在目录里，模型压根看不到。描述保持中文原文，模型正是
 * 按描述决定要不要加载。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { db, skills } from "@/db";
import { DATA_DIR } from "@/server/fs-safety";
import { assertSafeName } from "@/server/harness/ids";

/** 全局技能库根目录。 */
export const SKILL_LIBRARY_DIR = path.join(DATA_DIR, "skills");

/** frontmatter 里的字符串值：用双引号包裹并转义，名字里有冒号也不会破坏 YAML。 */
function quote(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " "));
}

/**
 * 库实体 → 上游认得的稳定技能名。目录不能依赖展示名：运行工作区持有的是指向
 * 这个目录的活链接，改名若换目录会让已经受理的运行断链。id 的摘要既满足上游
 * ASCII slug 约束，也避免把数据库 id 的标点规则扩散到技能协议。
 */
export function skillSlug(skill: { id: string }): string {
  return `skill-${createHash("sha256").update(skill.id, "utf8").digest("hex").slice(0, 20)}`;
}

function skillDir(slug: string): string {
  assertSafeName("技能目录名", slug);
  return path.join(SKILL_LIBRARY_DIR, slug);
}

/**
 * 把一个 Skill 写进磁盘投影。目录只由 id 决定，改名与正文更新都在同一路径内
 * 原子替换 SKILL.md，已经受理的运行所持活链接不会失效。
 */
export function materializeSkill(skill: {
  id: string;
  name: string;
  description: string;
  content: string;
}): void {
  const slug = skillSlug(skill);
  const dir = skillDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  // 描述里带上库里的中文名：模型只按描述选技能，slug 对它没有信息量。
  const description = `${skill.name}：${skill.description || skill.name}`;
  const frontmatter = [
    "---",
    `name: ${quote(slug)}`,
    `description: ${quote(description)}`,
    "---",
    "",
  ].join("\n");
  // 原子替换：运行启动时的 digestDirectory 在线程池里读技能目录，与这次写入在
  // OS 层任意交错；临时文件必须放在目录外，否则摘要枚举会把它也算成技能内容。
  // 同库根、异目录仍在同一文件系统，rename 保持原子性；唯一名也允许并发写同一技能。
  const tmp = path.join(SKILL_LIBRARY_DIR, `.skill-${slug}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${frontmatter}${skill.content}\n`, "utf8");
    fs.renameSync(tmp, path.join(dir, "SKILL.md"));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function removeSkillDir(slug: string): void {
  try {
    fs.rmSync(skillDir(slug), { recursive: true, force: true });
  } catch (err) {
    // 投影删不掉不该让删除失败：数据库才是真相，下次重建投影会收敛。
    console.error("[skills] 移除技能目录失败", slug, err);
  }
}

export function removeSkill(skill: { id: string; name: string }): void {
  removeSkillDir(skillSlug(skill));
}

/**
 * 按数据库重建整个投影。启动时跑一次，让磁盘与库对齐——
 * 直接改过数据库、或投影目录被人手删过，都靠这一步收敛。
 */
export function rebuildSkillLibrary(): void {
  fs.mkdirSync(SKILL_LIBRARY_DIR, { recursive: true });
  const rows = db.select().from(skills).all();
  const wanted = new Set(rows.map(skillSlug));
  for (const entry of fs.readdirSync(SKILL_LIBRARY_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !wanted.has(entry.name)) removeSkillDir(entry.name);
  }
  for (const row of rows) materializeSkill(row);
}
