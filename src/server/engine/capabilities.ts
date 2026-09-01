/**
 * 一次运行要带上的能力：技能与工具。
 *
 * 技能以 symlink 指向全局技能库的活目录（ADR-0007），由上游 skill-filesystem
 * 从会话 cwd 发现——模型看描述自行决定要不要加载，不强制注入（CONTEXT.md「Skill」）。
 * 工具物化成 cordis 插件文件放进运行目录，由每运行组合 include 进去。
 *
 * 能力归 Action 所有（action_skills / action_tools）。运行启动时先物化图上并集，
 * Tool 再由每个 Action 会话按自己的引用收窄，不能把 A 的能力泄漏给 B。
 */
import fs from "node:fs";
import path from "node:path";
import type { tools } from "@/db";
import { assertSafeId } from "@/server/harness/ids";
import type { NodeToolFilter } from "@/server/harness/rpc/types";
import type { RunWorkspace, ImportSpec } from "@/server/harness/workspace";
import { SKILL_LIBRARY_DIR, skillSlug } from "@/server/skill-library";
import type { ResolvedWorkflow } from "@/server/resolve";

export interface RunCapabilities {
  /** 传给 createRunWorkspace 的技能导入清单 */
  skills: ImportSpec[];
  /** 工具行：物化成插件文件时用 */
  tools: Array<typeof tools.$inferSelect>;
  /** Action id -> 该 Action 明确引用的工具公名。运行时据此收窄各会话的继承工具面。 */
  toolNamesByActionId: ReadonlyMap<string, readonly string[]>;
}

/** 从 resolve 时冻结的定义取整张图的技能与工具并集，不在运行启动后回读共享库。 */
export function collectCapabilities(resolved: ResolvedWorkflow): RunCapabilities {
  return {
    // 导入名必须是上游认得的 slug，工作区里的链接名同理——中文名会被静默忽略。
    skills: resolved.capabilities.skills.map((s) => ({
      name: skillSlug(s),
      sourceDir: path.join(SKILL_LIBRARY_DIR, skillSlug(s)),
    })),
    tools: resolved.capabilities.tools,
    toolNamesByActionId: resolved.capabilities.toolNamesByActionId,
  };
}

/**
 * 一次运行会把图上 Tool 的并集挂到全局层；每个 Action 会话必须再把自己未引用的
 * Tool 摘掉，否则 A 引用的破坏性能力会泄漏给 B。全局停用清单与这个会话级差集
 * 合并成同一份 deny，既保留 read/write 等基础工具，也不硬编码上游工具全集。
 */
export function toolFilterForAction(
  capabilities: Pick<RunCapabilities, "tools" | "toolNamesByActionId">,
  actionId: string,
  globallyDisabled: readonly string[],
): NodeToolFilter | undefined {
  const referenced = new Set(capabilities.toolNamesByActionId.get(actionId) ?? []);
  const deny = [
    ...new Set([
      ...globallyDisabled,
      ...capabilities.tools.flatMap((tool) => (referenced.has(tool.name) ? [] : [tool.name])),
    ]),
  ];
  return deny.length === 0 ? undefined : { deny };
}

/**
 * 把工具源码写进运行目录的 plugins/，返回组合要 include 的 entry。
 * 文件名与 entry id 从数据库 id 派生；展示名允许中文，不能拿来拼裸 YAML 路径。
 */
export function materializeToolPlugins(
  workspace: RunWorkspace,
  toolRows: Array<typeof tools.$inferSelect>,
): Array<{ id: string; modulePath: string }> {
  const entries: Array<{ id: string; modulePath: string }> = [];
  for (const tool of toolRows) {
    assertSafeId("工具 id", tool.id);
    const basename = `tool-${tool.id}`;
    const modulePath = path.join(workspace.pluginsDir, `${basename}.ts`);
    fs.writeFileSync(modulePath, tool.code, "utf8");
    entries.push({ id: basename, modulePath });
  }
  return entries;
}
