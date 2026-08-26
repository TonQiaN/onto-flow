/**
 * 一次运行要带上的能力：技能与工具。
 *
 * 技能以 symlink 指向全局技能库的活目录（ADR-0007），由上游 skill-filesystem
 * 从会话 cwd 发现——模型看描述自行决定要不要加载，不强制注入（CONTEXT.md「Skill」）。
 * 工具物化成 cordis 插件文件放进运行目录，由每运行组合 include 进去。
 *
 * 声明位置目前仍在 Action 上（action_skills / action_tools），本模块取全工作流的
 * 并集。按已定共识声明应当归工作流，那次搬迁只改本模块的取数，不影响物化本身。
 */
import fs from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { actionSkills, actionTools, db, skills, tools } from "@/db";
import { assertSafeName } from "@/server/harness/ids";
import type { RunWorkspace, ImportSpec } from "@/server/harness/workspace";
import { SKILL_LIBRARY_DIR, skillSlug } from "@/server/skill-library";
import type { ResolvedWorkflow } from "@/server/resolve";

export interface RunCapabilities {
  /** 传给 createRunWorkspace 的技能导入清单 */
  skills: ImportSpec[];
  /** 工具行：物化成插件文件时用 */
  tools: Array<typeof tools.$inferSelect>;
}

/** 取这张图上全部 Action 声明的技能与工具的并集。 */
export function collectCapabilities(resolved: ResolvedWorkflow): RunCapabilities {
  const actionIds = [...resolved.nodeRows.values()]
    .filter((n) => n.kind === "action" && n.actionId)
    .map((n) => n.actionId!);
  if (actionIds.length === 0) return { skills: [], tools: [] };

  const skillIds = [
    ...new Set(
      db
        .select({ skillId: actionSkills.skillId })
        .from(actionSkills)
        .where(inArray(actionSkills.actionId, actionIds))
        .all()
        .map((r) => r.skillId),
    ),
  ];
  const toolIds = [
    ...new Set(
      db
        .select({ toolId: actionTools.toolId })
        .from(actionTools)
        .where(inArray(actionTools.actionId, actionIds))
        .all()
        .map((r) => r.toolId),
    ),
  ];

  const skillRows = skillIds.length
    ? db.select().from(skills).where(inArray(skills.id, skillIds)).all()
    : [];
  const toolRows = toolIds.length
    ? db.select().from(tools).where(inArray(tools.id, toolIds)).all()
    : [];

  return {
    // 导入名必须是上游认得的 slug，工作区里的链接名同理——中文名会被静默忽略。
    skills: skillRows.map((s) => ({
      name: skillSlug(s),
      sourceDir: path.join(SKILL_LIBRARY_DIR, skillSlug(s)),
    })),
    tools: toolRows,
  };
}

/**
 * 把工具源码写进运行目录的 plugins/，返回组合要 include 的 entry。
 * 文件名与 entry id 都从工具名派生，因此工具名必须是安全的目录名形状。
 */
export function materializeToolPlugins(
  workspace: RunWorkspace,
  toolRows: Array<typeof tools.$inferSelect>,
): Array<{ id: string; modulePath: string }> {
  const entries: Array<{ id: string; modulePath: string }> = [];
  for (const tool of toolRows) {
    assertSafeName("工具名", tool.name);
    const modulePath = path.join(workspace.pluginsDir, `${tool.name}.ts`);
    fs.writeFileSync(modulePath, tool.code, "utf8");
    // entry id 只允许字母数字与 -_，工具名里的点要换掉。
    entries.push({ id: `tool-${tool.name.replace(/[^A-Za-z0-9_-]/g, "-")}`, modulePath });
  }
  return entries;
}
