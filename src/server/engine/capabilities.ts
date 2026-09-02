/**
 * 一次运行要带上的能力：工作流的技能集与 Tool 集（ADR-0016）。
 *
 * 技能以 symlink 指向全局技能库的活目录（ADR-0007），由上游 skill-filesystem
 * 从会话 cwd 发现——技能集对全部 Action 可见，模型看描述自行决定要不要加载；
 * 必定要用上的由 Action 预载（`/<slug>` 手势，见 action.ts）。
 * Tool 集声明即物化：每个 Tool 套上平台的 cordis 包装写进运行目录（ADR-0017），
 * 注册到全局工具面，再由每个 Action 会话按自己的可见子集收窄。
 *
 * 两个集合都从 resolve 时冻结的定义取，不在运行启动后回读共享库。
 */
import path from "node:path";
import type { tools } from "@/db";
import type { NodeToolFilter } from "@/server/harness/rpc/types";
import {
  materializeToolPlugin,
  type ToolPluginEntry,
  type ToolPluginOptions,
} from "@/server/harness/tool-plugin";
import type { RunWorkspace, ImportSpec } from "@/server/harness/workspace";
import { SKILL_LIBRARY_DIR } from "@/server/skill-library";
import type { ResolvedSkillRef, ResolvedWorkflow } from "@/server/resolve";

export interface RunCapabilities {
  /** 传给 createRunWorkspace 的技能导入清单（工作流技能集，名字是 slug） */
  skills: ImportSpec[];
  /** 技能集的实体身份：节点快照与投影持有都按它 */
  skillRefs: ResolvedSkillRef[];
  /** 工作流 Tool 集全量行：物化成包装插件时用 */
  tools: Array<typeof tools.$inferSelect>;
  /** Action id -> 该 Action 可见的 Tool 公名。运行时据此收窄各会话的继承工具面。 */
  toolNamesByActionId: ReadonlyMap<string, readonly string[]>;
}

/** 从 resolve 时冻结的定义取工作流的技能集与 Tool 集，不在运行启动后回读共享库。 */
export function collectCapabilities(resolved: ResolvedWorkflow): RunCapabilities {
  return {
    // 导入名必须是上游认得的 slug，工作区里的链接名同理——中文名会被静默忽略。
    skills: resolved.capabilities.skills.map((s) => ({
      name: s.slug,
      sourceDir: path.join(SKILL_LIBRARY_DIR, s.slug),
    })),
    skillRefs: resolved.capabilities.skills,
    tools: resolved.capabilities.tools,
    toolNamesByActionId: resolved.capabilities.toolNamesByActionId,
  };
}

/**
 * 一次运行把工作流 Tool 集全部挂到全局层；每个 Action 会话必须再把自己未勾选的
 * Tool 摘掉，否则 A 勾选的破坏性能力会泄漏给 B。全局停用清单与这个会话级差集
 * 合并成同一份 deny：deny = disabledTools ∪ (工作流 Tool 公名 − 本 Action 可见公名)。
 * 既保留 read/write 等基础工具，也不硬编码上游工具全集。
 */
export function toolFilterForAction(
  capabilities: Pick<RunCapabilities, "tools" | "toolNamesByActionId">,
  actionId: string,
  globallyDisabled: readonly string[],
): NodeToolFilter | undefined {
  const visible = new Set(capabilities.toolNamesByActionId.get(actionId) ?? []);
  const deny = [
    ...new Set([
      ...globallyDisabled,
      ...capabilities.tools.flatMap((tool) =>
        visible.has(tool.publicName) ? [] : [tool.publicName],
      ),
    ]),
  ];
  return deny.length === 0 ? undefined : { deny };
}

/**
 * 把工作流 Tool 集全部物化进运行目录的 plugins/（execute 模块 + 平台包装），
 * 返回组合要 include 的 entry。envKeys 是 execute 模块能看见的环境变量名白名单。
 */
export function materializeToolPlugins(
  workspace: RunWorkspace,
  toolRows: ReadonlyArray<typeof tools.$inferSelect>,
  options: ToolPluginOptions,
): ToolPluginEntry[] {
  return toolRows.map((tool) => materializeToolPlugin(workspace, tool, options));
}
