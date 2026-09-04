import { asc, eq } from "drizzle-orm";
import { db, skillFiles, skills } from "@/db";
import {
  foldSkillPath,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_MAX_COUNT,
  skillFilePathProblem,
} from "@/lib/skill-files";
import { recordRevision } from "@/server/revisions";
import { materializeSkill } from "@/server/skill-library";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

export interface SkillFilePayload {
  /** 技能目录内的相对路径，以 / 分段 */
  path: string;
  content: Buffer;
}

export interface SkillPayload {
  name: string;
  description: string;
  /** SKILL.md 正文（不含 frontmatter） */
  content: string;
  files: SkillFilePayload[];
}

export type SkillRow = typeof skills.$inferSelect;

/** GET / PUT / POST 的响应：库行加资源文件清单（内容以 base64 传输）。 */
export interface SkillDto extends SkillRow {
  files: Array<{ path: string; contentBase64: string; size: number }>;
}

/** 严格 base64：Node 的解码器对非法输入很宽容，先按字面挡住才不会把乱码当文件存进去。 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseSkillFiles(raw: unknown): WriteResult<SkillFilePayload[]> {
  if (raw === undefined) return writeOk([]);
  if (!Array.isArray(raw)) return writeFail(400, "files 必须是数组");
  if (raw.length > SKILL_FILE_MAX_COUNT)
    return writeFail(400, `资源文件最多 ${SKILL_FILE_MAX_COUNT} 个，收到 ${raw.length} 个`);

  const files: SkillFilePayload[] = [];
  const paths = new Set<string>();
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return writeFail(400, "资源文件格式不正确：每项须是 { path, contentBase64 }");
    const file = item as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "";
    const problem = skillFilePathProblem(path);
    if (problem) return writeFail(400, problem);
    // macOS 默认文件系统不分大小写、也不分 Unicode 正规化形式：Readme.md 与 readme.md、NFC 与 NFD
    // 的 café.md 都会落到同一个文件，按折叠后的键查重
    if (paths.has(foldSkillPath(path)))
      return writeFail(400, `资源文件路径重复（不区分大小写与 Unicode 正规化）：「${path}」`);
    const encoded = typeof file.contentBase64 === "string" ? file.contentBase64 : null;
    if (encoded === null) return writeFail(400, `资源文件「${path}」缺少 contentBase64`);
    if (!BASE64_PATTERN.test(encoded))
      return writeFail(400, `资源文件「${path}」的 contentBase64 不是合法的 base64`);
    const content = Buffer.from(encoded, "base64");
    if (content.length > SKILL_FILE_MAX_BYTES)
      return writeFail(400, `资源文件「${path}」超过 1 MiB（${content.length} 字节）`);
    paths.add(foldSkillPath(path));
    files.push({ path, content });
  }

  // 同一个名字不能既是文件又是别的文件的目录：投影时 mkdir 会撞上已写好的文件。
  // 同样按折叠后的键比较：docs 与 DOCS/x 在不分大小写的文件系统上是同一个目录。
  for (const path of paths) {
    for (const other of paths) {
      if (other !== path && other.startsWith(`${path}/`))
        return writeFail(
          400,
          `资源文件路径「${path}」既是文件又是「${other}」的目录（不区分大小写）`,
        );
    }
  }
  return writeOk(files);
}

export function parseSkillPayload(raw: unknown): WriteResult<SkillPayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  const files = parseSkillFiles(body.files);
  if (!files.ok) return files;

  return writeOk({
    name,
    description: typeof body.description === "string" ? body.description : "",
    content: typeof body.content === "string" ? body.content : "",
    files: files.data,
  });
}

/** 修订 payload：完整目录——正文加全部资源文件（base64），回滚原样写回。 */
function revisionPayload(p: SkillPayload): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    content: p.content,
    files: p.files.map((f) => ({ path: f.path, contentBase64: f.content.toString("base64") })),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function replaceFiles(tx: Tx, skillId: string, files: SkillFilePayload[]) {
  tx.delete(skillFiles).where(eq(skillFiles.skillId, skillId)).run();
  if (files.length > 0)
    tx.insert(skillFiles)
      .values(
        files.map((f) => ({ skillId, path: f.path, content: f.content, size: f.content.length })),
      )
      .run();
}

/** 该技能的资源文件行，按路径排序；投影与 DTO 都从这里取。 */
export function loadSkillFiles(
  skillId: string,
): Array<{ path: string; content: Buffer; size: number }> {
  return db
    .select({ path: skillFiles.path, content: skillFiles.content, size: skillFiles.size })
    .from(skillFiles)
    .where(eq(skillFiles.skillId, skillId))
    .orderBy(asc(skillFiles.path))
    .all();
}

export function loadSkillDto(id: string): SkillDto | null {
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!row) return null;
  return {
    ...row,
    files: loadSkillFiles(id).map((f) => ({
      path: f.path,
      contentBase64: f.content.toString("base64"),
      size: f.size,
    })),
  };
}

export function createSkill(raw: unknown): WriteResult<SkillDto> {
  const parsed = parseSkillPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(skills)
      .values({ name: p.name, description: p.description, content: p.content })
      .returning()
      .get();
    replaceFiles(tx, inserted.id, p.files);
    recordRevision("skill", inserted.id, revisionPayload(p), "", tx);
    return inserted;
  });
  // 磁盘投影跟着落：运行工作区里的技能是指向它的 symlink。
  materializeSkill(row, p.files);
  const dto = loadSkillDto(row.id);
  return dto ? writeOk(dto) : writeFail(500, "技能创建后读取失败");
}

/** PUT 与回滚共用的写入路径：正文与资源文件整体替换 */
export function writeSkill(id: string, raw: unknown): WriteResult<SkillDto> {
  const existing = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!existing) return writeFail(404, "技能不存在");

  const parsed = parseSkillPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const updated = tx
      .update(skills)
      .set({ name: p.name, description: p.description, content: p.content })
      .where(eq(skills.id, id))
      .returning()
      .get();
    replaceFiles(tx, id, p.files);
    recordRevision("skill", id, revisionPayload(p), "", tx);
    return updated;
  });
  // slug 只由 id 派生；整个目录原子换名，运行中的活链接在改名时也保持有效。
  materializeSkill(row, p.files);
  const dto = loadSkillDto(id);
  return dto ? writeOk(dto) : writeFail(404, "技能不存在");
}
