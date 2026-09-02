/**
 * 全局技能库的磁盘投影：把 skills 表的行与 skill_files 的资源文件物化成 dsh 认得的技能目录。
 *
 * 数据库仍是唯一真相，磁盘是它的投影——每次写 Skill 就重写对应目录。
 * 运行工作区里的技能是指向这里的 symlink（ADR-0007），所以「活目录」指的就是
 * 本模块维护的这份投影：全局库改完，下一次运行即生效。
 *
 * 目录形态对齐上游 skill-filesystem：<root>/<slug>/SKILL.md 加 <root>/<slug>/<path> 的
 * 资源文件（ADR-0016），平铺 frontmatter 必填 name 与 description。
 *
 * <root>/<slug> 本身是一个符号链接，指向 <root>/.versions/<slug>-<stamp>/ 里的一份完整投影。
 * 重写技能时先把新版本整目录写好，再用一次 rename 把新链接换到 <slug> 上：路径没有任何
 * 不存在的瞬间，运行工作区里指向 <slug> 的链接、受理检查、节点读投影、上游 pre-step 的技能
 * 读取都不会撞上半成品或空档。旧版本目录在没有已受理运行持有该技能时立即删除，否则等最后
 * 一个持有者收束后再删——上游若在发现技能时记住了真实路径，运行中途也不会读到已删的目录。
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
import { asc, eq } from "drizzle-orm";
import { db, skillFiles, skills } from "@/db";
import { DATA_DIR } from "@/server/fs-safety";
import { assertSafeName } from "@/server/harness/ids";

interface SkillLibraryGlobals {
  /** skill slug -> 仍可能读取该投影的已受理运行。挂全局避免 HMR 丢失所有权。 */
  ontoflowSkillProjectionHolds?: Map<string, Set<string>>;
  /** 数据库行已删除，但投影仍被已受理运行持有；最后一个持有者释放后再删目录。 */
  ontoflowPendingSkillProjectionRemovals?: Set<string>;
  /** slug -> 被新版本换下、但仍有已受理运行持有该技能的旧版本目录名；持有释放后再删。 */
  ontoflowPendingSkillVersionRemovals?: Map<string, Set<string>>;
}

const g = globalThis as SkillLibraryGlobals;
const projectionHolds = g.ontoflowSkillProjectionHolds ?? new Map<string, Set<string>>();
g.ontoflowSkillProjectionHolds = projectionHolds;
const pendingRemovals =
  g.ontoflowPendingSkillProjectionRemovals ?? new Set<string>();
g.ontoflowPendingSkillProjectionRemovals = pendingRemovals;
const pendingVersionRemovals =
  g.ontoflowPendingSkillVersionRemovals ?? new Map<string, Set<string>>();
g.ontoflowPendingSkillVersionRemovals = pendingVersionRemovals;

/** 全局技能库根目录。 */
export const SKILL_LIBRARY_DIR = path.join(DATA_DIR, "skills");

/** 版本目录都在这一层；<slug> 链接指向其中一份。 */
const VERSIONS_DIR_NAME = ".versions";
const VERSIONS_DIR = path.join(SKILL_LIBRARY_DIR, VERSIONS_DIR_NAME);
/** 换链接用的临时链接名后缀；重建时把残留一并清掉。 */
const TEMP_LINK_SUFFIX = ".link.tmp";

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

const SLUG_PATTERN = /^skill-[0-9a-f]{20}$/;

function skillDir(slug: string): string {
  assertSafeName("技能目录名", slug);
  return path.join(SKILL_LIBRARY_DIR, slug);
}

function skillFile(slug: string): string {
  return path.join(skillDir(slug), "SKILL.md");
}

/** 版本目录名 <slug>-<uuid>；slug 定长，所以按前缀归属不会串到别的技能。 */
function versionDirName(slug: string, stamp: string): string {
  return `${slug}-${stamp}`;
}

function slugOfVersion(name: string): string | null {
  const slug = name.slice(0, "skill-".length + 20);
  return SLUG_PATTERN.test(slug) && name.startsWith(`${slug}-`) ? slug : null;
}

function versionNamesOf(slug: string): string[] {
  try {
    return fs.readdirSync(VERSIONS_DIR).filter((name) => slugOfVersion(name) === slug);
  } catch {
    return [];
  }
}

/** <slug> 链接当前指向的版本目录名；不是链接（不存在或旧式真实目录）时返回 null。 */
function currentVersionName(slug: string): string | null {
  try {
    return path.basename(fs.readlinkSync(skillDir(slug)));
  } catch {
    return null;
  }
}

function isHeld(slug: string): boolean {
  return (projectionHolds.get(slug)?.size ?? 0) > 0;
}

/** 删一个版本目录；技能仍被已受理运行持有时先记下，等释放后再删。 */
function retireVersion(slug: string, versionName: string): void {
  if (isHeld(slug)) {
    const names = pendingVersionRemovals.get(slug) ?? new Set<string>();
    names.add(versionName);
    pendingVersionRemovals.set(slug, names);
    return;
  }
  fs.rmSync(path.join(VERSIONS_DIR, versionName), { recursive: true, force: true });
}

function flushRetiredVersions(slug: string): void {
  const names = pendingVersionRemovals.get(slug);
  if (!names) return;
  pendingVersionRemovals.delete(slug);
  for (const name of names) {
    fs.rmSync(path.join(VERSIONS_DIR, name), { recursive: true, force: true });
  }
}

export interface SkillProjectionFile {
  /** 技能目录内的相对路径，写入口已校验形状（src/server/writers/skill.ts） */
  path: string;
  content: Buffer;
}

/**
 * 把一个 Skill 写进磁盘投影：正文成为 SKILL.md，资源文件按相对路径落在同一目录。
 * 目录只由 id 决定，改名、正文与资源文件更新都在同一路径内换版本，已经受理的
 * 运行所持活链接不会失效。
 */
export function materializeSkill(
  skill: {
    id: string;
    name: string;
    description: string;
    content: string;
  },
  files: ReadonlyArray<SkillProjectionFile> = [],
): void {
  const slug = skillSlug(skill);
  const dir = skillDir(slug);
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  // 描述里带上库里的中文名：模型只按描述选技能，slug 对它没有信息量。
  const description = `${skill.name}：${skill.description || skill.name}`;
  const frontmatter = [
    "---",
    `name: ${quote(slug)}`,
    `description: ${quote(description)}`,
    "---",
    "",
  ].join("\n");
  // 新版本整目录写在 .versions/ 下：在链接换过去之前，<slug> 路径下看不到任何半成品——
  // 运行启动时的 digestDirectory 在线程池里经工作区链接读技能目录，与这次写入在 OS 层任意交错。
  const stamp = crypto.randomUUID();
  const versionName = versionDirName(slug, stamp);
  const version = path.join(VERSIONS_DIR, versionName);
  const tempLink = path.join(SKILL_LIBRARY_DIR, `.${versionName}${TEMP_LINK_SUFFIX}`);
  let previous: string | null = null;
  try {
    fs.mkdirSync(version);
    fs.writeFileSync(path.join(version, "SKILL.md"), `${frontmatter}${skill.content}\n`, "utf8");
    for (const file of files) {
      const target = path.join(version, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    // 换链接：临时名建好新链接，再 rename 到 <slug>——rename 覆盖一个已有的符号链接是原子的，
    // <slug> 没有不存在的瞬间。<slug> 若是旧式的真实目录（改成链接之前的投影），先整个移走：
    // 这只会在进程启动重建时遇到，那时没有运行在跑。并发重写同一技能时后到者的链接覆盖先到者，
    // 先到者的版本目录成为孤儿，下次启动重建收敛。
    let current: fs.Stats | null = null;
    try {
      current = fs.lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (current?.isSymbolicLink()) previous = currentVersionName(slug);
    else if (current) fs.rmSync(dir, { recursive: true, force: true });
    fs.symlinkSync(path.posix.join(VERSIONS_DIR_NAME, versionName), tempLink, "dir");
    fs.renameSync(tempLink, dir);
  } catch (err) {
    fs.rmSync(tempLink, { force: true });
    fs.rmSync(version, { recursive: true, force: true });
    throw err;
  }
  // 成功写回后取消先前的延迟删除意图（启动重建会对库里仍存在的行再走一遍这里）。
  pendingRemovals.delete(slug);
  if (previous !== null && previous !== versionName) retireVersion(slug, previous);
}

/** 删掉 <slug> 链接（或旧式真实目录）与它的全部版本目录。 */
export function removeSkillDir(slug: string): void {
  try {
    fs.rmSync(skillDir(slug), { recursive: true, force: true });
    for (const name of versionNamesOf(slug)) {
      fs.rmSync(path.join(VERSIONS_DIR, name), { recursive: true, force: true });
    }
    pendingVersionRemovals.delete(slug);
  } catch (err) {
    // 投影删不掉不该让删除失败：数据库才是真相，下次重建投影会收敛。
    console.error("[skills] 移除技能目录失败", slug, err);
  }
}

export function removeSkill(skill: { id: string; name: string }): void {
  const slug = skillSlug(skill);
  if (isHeld(slug)) {
    pendingRemovals.add(slug);
    return;
  }
  pendingRemovals.delete(slug);
  removeSkillDir(slug);
}

/**
 * 受理运行时取得 Skill 投影的生命期所有权。检查与登记都是同步操作：删除请求只能
 * 发生在它们之前或之后，不能卡在中间。缺失投影在返回 runId 前失败，避免先跑付费节点
 * 再由后续 Action 发现断链。
 */
export function retainSkillProjections(
  runId: string,
  skillRows: ReadonlyArray<{ id: string; name: string }>,
): void {
  const retained: string[] = [];
  try {
    for (const skill of skillRows) {
      const slug = skillSlug(skill);
      if (retained.includes(slug)) continue;
      if (pendingRemovals.has(slug)) {
        throw new Error(`技能「${skill.name}」已删除，不能用于本次运行`);
      }
      try {
        const stat = fs.statSync(skillFile(slug));
        if (!stat.isFile()) throw new Error("投影不是普通文件");
        fs.accessSync(skillFile(slug), fs.constants.R_OK);
      } catch {
        throw new Error(`技能「${skill.name}」的磁盘投影不存在或不可读`);
      }
      const holders = projectionHolds.get(slug) ?? new Set<string>();
      holders.add(runId);
      projectionHolds.set(slug, holders);
      retained.push(slug);
    }
  } catch (error) {
    for (const slug of retained) {
      const holders = projectionHolds.get(slug);
      holders?.delete(runId);
      if (holders?.size === 0) projectionHolds.delete(slug);
    }
    throw error instanceof Error ? error : new Error("技能磁盘投影不可读");
  }
}

/**
 * 运行完全静止后释放投影；若网页已删除该 Skill，最后一个运行释放时才真正删目录，
 * 否则只删运行期间被换下的旧版本。清理投影失败只记日志，不能把已经写好的运行终态改坏。
 */
export function releaseSkillProjections(
  runId: string,
  skillRows: ReadonlyArray<{ id: string; name: string }>,
): void {
  for (const slug of new Set(skillRows.map(skillSlug))) {
    const holders = projectionHolds.get(slug);
    holders?.delete(runId);
    if ((holders?.size ?? 0) > 0) continue;
    projectionHolds.delete(slug);
    if (pendingRemovals.delete(slug)) {
      removeSkillDir(slug);
      continue;
    }
    try {
      flushRetiredVersions(slug);
    } catch (err) {
      console.error("[skills] 清理旧版本目录失败", slug, err);
    }
  }
}

/**
 * 按数据库重建整个投影。启动时跑一次，让磁盘与库对齐——
 * 直接改过数据库、或投影目录被人手删过，都靠这一步收敛。
 */
export function rebuildSkillLibrary(): void {
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  const rows = db.select().from(skills).all();
  const wanted = new Set(rows.map(skillSlug));
  for (const entry of fs.readdirSync(SKILL_LIBRARY_DIR, { withFileTypes: true })) {
    if (entry.name === VERSIONS_DIR_NAME || wanted.has(entry.name)) continue;
    if (!SLUG_PATTERN.test(entry.name)) {
      // 上次进程中途倒下留下的临时链接或半成品：不是任何技能，直接清掉。
      fs.rmSync(path.join(SKILL_LIBRARY_DIR, entry.name), { recursive: true, force: true });
      continue;
    }
    if (isHeld(entry.name)) {
      pendingRemovals.add(entry.name);
    } else {
      removeSkillDir(entry.name);
    }
  }
  for (const row of rows) {
    const files = db
      .select({ path: skillFiles.path, content: skillFiles.content })
      .from(skillFiles)
      .where(eq(skillFiles.skillId, row.id))
      .orderBy(asc(skillFiles.path))
      .all();
    materializeSkill(row, files);
  }
  // 版本目录的收敛：不被任何 <slug> 链接指向的版本是孤儿（并发重写的输家、上次进程中途倒下），
  // 技能没被持有就删掉；被持有的留到释放时一起清。
  const live = new Set<string>();
  for (const slug of wanted) {
    const name = currentVersionName(slug);
    if (name !== null) live.add(name);
  }
  for (const name of fs.readdirSync(VERSIONS_DIR)) {
    if (live.has(name)) continue;
    const slug = slugOfVersion(name);
    if (slug !== null && wanted.has(slug) && isHeld(slug)) {
      retireVersion(slug, name);
      continue;
    }
    fs.rmSync(path.join(VERSIONS_DIR, name), { recursive: true, force: true });
  }
}
