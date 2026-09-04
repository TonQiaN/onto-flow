/**
 * 付费冒烟共用的夹具、等待与断言。
 *
 * 三条纪律，改这个文件前先读一遍：
 *
 * 一、**实体一律经写入器落库**（`createAction` / `writeAction` 与同族）。冒烟脚本按
 * `docs/simplifications/README.md` 的语料分类算生产代码，`AGENTS.md`「Every entity write
 * records a revision」对它同样成立；直插 `db.insert(actions)` 快是快，但那条路不留修订，
 * 与产品真实写路径也不是同一条，冒烟因此验不到写入器的校验。
 *
 * 二、**幂等靠比对而不是靠删重建**：定义没变且已有修订就一个字节都不写，免得每跑一次
 * 冒烟就给库里堆一版无意义的修订。
 *
 * 三、**检查失败一律抛**。冒烟是唯一会真调模型的门（`.github/workflows/smoke.yml` 每天
 * 定时跑它），只打印不抛等于永远绿。断言只钉「终态 success」「声明的产物存在」「关键子串
 * 出现」这三类可复现的事实，不钉字数、行数与模型措辞——那会把偶发的措辞波动变成红灯。
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  actions,
  db,
  type EntityKind,
  models,
  objectTypes,
  revisions,
  runEvents,
  runNodeRounds,
  runNodes,
  runs,
  skills,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import { DATA_DIR } from "../src/server/fs-safety";
import { materializeSkill } from "../src/server/skill-library";
import {
  createAction,
  loadActionDto,
  writeAction,
  type ActionPayload,
  type PortPayload,
} from "../src/server/writers/action";
import {
  createSkill,
  loadSkillDto,
  loadSkillFiles,
  writeSkill,
  type SkillDto,
} from "../src/server/writers/skill";
import { createTool, writeTool, type ToolPayload, type ToolRow } from "../src/server/writers/tool";
import {
  createObjectType,
  writeObjectType,
  type ObjectTypePayload,
} from "../src/server/writers/object-type";
import type { WriteResult } from "../src/server/writers/types";
import {
  createWorkflow,
  loadWorkflowSets,
  writeWorkflow,
  type EdgePayload,
  type NodePayload,
  type WorkflowRow,
} from "../src/server/writers/workflow";
import { EMPTY_WORKFLOW_SETTINGS } from "../src/lib/workflow-settings";
import { totalUsageTokens } from "./token-total";

export type ModelRow = typeof models.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

/** 写入器的失败即脚本的失败：把 `WriteResult` 的错误原样抛出去。 */
export function unwrap<T>(result: WriteResult<T>): T {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
}

/** 冒烟里的每一项检查都走它：失败即抛，进程退出码非零。 */
export function assertSmoke(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 没有凭据就没有付费冒烟；提前抛，不要跑到一半才发现。 */
export function requireCredential(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("缺少 DEEPSEEK_API_KEY：冒烟要真实调用模型");
  }
}

/** 取一行模型定义；缺行说明没跑过 db:seed。 */
export function requireModel(modelId = "deepseek-v4-flash"): ModelRow {
  const model = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, "deepseek-official"), eq(models.modelId, modelId)))
    .get();
  if (!model) throw new Error(`找不到 deepseek-official/${modelId} 模型行，先跑 npm run db:seed`);
  return model;
}

function hasRevision(kind: EntityKind, entityId: string): boolean {
  return !!db
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.entityKind, kind), eq(revisions.entityId, entityId)))
    .limit(1)
    .get();
}

function sameDefinition(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function upsertObjectType(name: string, kind: "text" | "file" | "json"): string {
  const desired: ObjectTypePayload = { name, kind, description: "冒烟用", jsonSchema: null };
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (!existing) return unwrap(createObjectType(desired)).id;
  const current: ObjectTypePayload = {
    name: existing.name,
    kind: existing.kind,
    description: existing.description,
    jsonSchema: existing.jsonSchema,
  };
  if (!sameDefinition(current, desired) || !hasRevision("object_type", existing.id)) {
    unwrap(writeObjectType(existing.id, desired));
  }
  return existing.id;
}

/** 端口夹具：输出端口才有 artifactPath 与 exitName（ADR-0008 / ADR-0009）。 */
export interface PortFixture {
  name: string;
  objectTypeId: string;
  artifactPath?: string;
  exitName?: string;
}

export interface ActionFixture {
  name: string;
  prompt: string;
  rule: string;
  modelId: string;
  inputs: PortFixture[];
  outputs: PortFixture[];
  description?: string;
  reasoningEffort?: ActionPayload["reasoningEffort"];
  maxReentries?: number;
  onExhausted?: "fail" | "accept";
  preloadSkillIds?: string[];
  toolIds?: string[];
}

function actionPayload(input: ActionFixture): ActionPayload {
  const port = (p: PortFixture, direction: "input" | "output", position: number): PortPayload => ({
    direction,
    name: p.name,
    objectTypeId: p.objectTypeId,
    position,
    artifactPath: direction === "output" ? (p.artifactPath ?? null) : null,
    exitName: direction === "output" ? (p.exitName ?? null) : null,
  });
  return {
    name: input.name,
    description: input.description ?? "冒烟用",
    prompt: input.prompt,
    rule: input.rule,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort ?? "low",
    maxReentries: input.maxReentries ?? 0,
    onExhausted: input.onExhausted ?? "fail",
    ports: [
      ...input.inputs.map((p, i) => port(p, "input", i)),
      ...input.outputs.map((p, i) => port(p, "output", i)),
    ],
    preloadSkillIds: input.preloadSkillIds ?? [],
    toolIds: input.toolIds ?? [],
  };
}

function normalizedAction(payload: ActionPayload): ActionPayload {
  return {
    ...payload,
    ports: [...payload.ports].sort(
      (left, right) =>
        left.direction.localeCompare(right.direction) ||
        left.position - right.position ||
        left.name.localeCompare(right.name),
    ),
    preloadSkillIds: [...payload.preloadSkillIds].sort(),
    toolIds: [...payload.toolIds].sort(),
  };
}

/** 按名字找 Action，缺则建、变则改；返回 id。 */
export function upsertAction(input: ActionFixture): string {
  const desired = actionPayload(input);
  const existing = db.select().from(actions).where(eq(actions.name, input.name)).get();
  if (!existing) return unwrap(createAction(desired)).id;

  const dto = loadActionDto(existing.id);
  if (!dto) throw new Error(`Action「${input.name}」读取失败`);
  const current: ActionPayload = {
    name: dto.name,
    description: dto.description,
    prompt: dto.prompt,
    rule: dto.rule,
    modelId: dto.modelId,
    reasoningEffort: dto.reasoningEffort,
    maxReentries: dto.maxReentries,
    onExhausted: dto.onExhausted,
    ports: dto.ports.map((p) => ({
      direction: p.direction,
      name: p.name,
      objectTypeId: p.objectTypeId,
      position: p.position,
      artifactPath: p.artifactPath,
      exitName: p.exitName,
    })),
    preloadSkillIds: dto.preloadSkillIds,
    toolIds: dto.toolIds,
  };
  if (
    !sameDefinition(normalizedAction(current), normalizedAction(desired)) ||
    !hasRevision("action", existing.id)
  ) {
    unwrap(writeAction(existing.id, desired));
  }
  return existing.id;
}

export interface SkillFixture {
  name: string;
  description: string;
  content: string;
}

/** 按名字找 Skill，缺则建、变则改；写入器同时把磁盘投影物化出来。 */
export function upsertSkill(input: SkillFixture): SkillDto {
  const desired = { ...input, files: [] };
  const existing = db.select().from(skills).where(eq(skills.name, input.name)).get();
  if (!existing) return unwrap(createSkill(desired));
  const dto = loadSkillDto(existing.id);
  if (!dto) throw new Error(`技能「${input.name}」读取失败`);
  const current = {
    name: dto.name,
    description: dto.description,
    content: dto.content,
    files: dto.files.map((f) => f.path),
  };
  if (!sameDefinition(current, { ...input, files: [] }) || !hasRevision("skill", existing.id)) {
    return unwrap(writeSkill(existing.id, desired));
  }
  // 定义没变也**照样重投一次**磁盘投影：受理时读的是 data/skills/<slug>，而冒烟脚本不经
  // Next 的启动重建钩子（src/instrumentation.ts）。写入器提交事务之后、换链接之前
  // materializeSkill 抛了的话，库里已是新定义而盘上还是旧 SKILL.md——任何「投影是不是旧的」
  // 判据都只能猜（正文被改短时旧文件仍包含新正文，子串比对就漏了），而重投一次是确定的：
  // 库里的行是唯一事实源，重投只换目录、不记修订，代价是一个新版本目录立即顶掉旧的。
  materializeSkill(dto, loadSkillFiles(dto.id));
  return dto;
}

/** 按公名找 Tool（公名是模型调用与收窄用的身份），缺则建、变则改。 */
export function upsertTool(input: ToolPayload): ToolRow {
  const existing = db.select().from(tools).where(eq(tools.publicName, input.publicName)).get();
  if (!existing) return unwrap(createTool(input));
  const current: ToolPayload = {
    name: existing.name,
    publicName: existing.publicName,
    description: existing.description,
    parameters: existing.parameters,
    output: existing.output,
    timeoutMs: existing.timeoutMs,
    code: existing.code,
  };
  if (!sameDefinition(current, input) || !hasRevision("tool", existing.id)) {
    return unwrap(writeTool(existing.id, input));
  }
  return existing;
}

export interface WorkflowFixture {
  name: string;
  description: string;
  /** 物化为 workspace/AGENTS.md 的工作流级指令；省略即空串（ADR-0016）。 */
  instructions?: string;
  skillIds?: string[];
  toolIds?: string[];
  /** 节点 id 由调用方给定：它同时是会话 id 与 inputs/ 下的目录段，固定值才可复现。 */
  nodes: NodePayload[];
  edges: EdgePayload[];
}

// 冒烟的工作流一律不覆盖任何插件开关、不挂 MCP：这些工作流常年留在库里，谁在网页上把
// webSearch 打开都会让下一次付费冒烟跑在另一份组合上、为与被测代码无关的原因红。settings
// 因此进「整体替换」的声明面——writeWorkflow 对缺省的 settings 是「沿用现值」（ADR-0016）。
const FIXTURE_SETTINGS = EMPTY_WORKFLOW_SETTINGS;

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

/** 按名字找工作流，缺则建；图与三层设置字段整体替换。 */
export function upsertWorkflow(input: WorkflowFixture): WorkflowRow {
  const desired = {
    name: input.name,
    description: input.description,
    instructions: input.instructions ?? "",
    settings: FIXTURE_SETTINGS,
    skillIds: [...(input.skillIds ?? [])].sort(),
    toolIds: [...(input.toolIds ?? [])].sort(),
    nodes: byId(input.nodes),
    edges: byId(input.edges),
  };
  let wf = db.select().from(workflows).where(eq(workflows.name, input.name)).get();
  if (!wf) {
    // 按名字找不到就按节点 id 认领：`workflow_nodes.id` 是全表主键，冒烟的节点 id 是固定值，
    // 工作流一旦在网页上被改名，「按名字新建一份」就会拿这些 id 撞主键，冒烟还没花钱就先红。
    // 认领回来之后名字由下面的整体替换改回去（Codex 对本 PR 的十一轮复审）。
    // 认领的门槛是**整套节点 id 都归它**：只对上一个 id 就改名重写，等于把一张碰巧用了同名
    // 节点 id 的用户图整个覆盖掉；对不齐就响亮失败，让人自己去解冲突（十二轮复审）。
    const anchor = input.nodes[0];
    const owner = anchor
      ? db
          .select({ workflowId: workflowNodes.workflowId })
          .from(workflowNodes)
          .where(eq(workflowNodes.id, anchor.id))
          .get()
      : undefined;
    if (owner) {
      const owned = new Set(
        db
          .select({ id: workflowNodes.id })
          .from(workflowNodes)
          .where(eq(workflowNodes.workflowId, owner.workflowId))
          .all()
          .map((row) => row.id),
      );
      const candidate = db.select().from(workflows).where(eq(workflows.id, owner.workflowId)).get();
      const missing = input.nodes.filter((node) => !owned.has(node.id)).map((node) => node.id);
      if (missing.length > 0) {
        throw new Error(
          `节点 id「${anchor?.id}」已属于工作流「${candidate?.name ?? owner.workflowId}」，` +
            `但那张图缺少本夹具的其余节点（${missing.join("、")}），不是改过名的冒烟工作流；` +
            `请改掉那张图的节点 id，或换掉本冒烟的固定节点 id 再跑`,
        );
      }
      wf = candidate;
      if (wf) console.log(`按整套节点 id 认领了改过名的工作流：「${wf.name}」→「${input.name}」`);
    }
  }
  if (!wf) {
    wf = unwrap(
      createWorkflow({
        name: input.name,
        description: input.description,
        instructions: desired.instructions,
        settings: desired.settings,
        skillIds: desired.skillIds,
        toolIds: desired.toolIds,
      }),
    );
  }
  const sets = loadWorkflowSets(wf.id);
  const current = {
    name: wf.name,
    description: wf.description,
    instructions: wf.instructions,
    settings: {
      toggles: wf.settings.toggles ?? {},
      mcpServers: wf.settings.mcpServers ?? [],
    },
    skillIds: [...sets.skillIds].sort(),
    toolIds: [...sets.toolIds].sort(),
    nodes: byId(
      db
        .select()
        .from(workflowNodes)
        .where(eq(workflowNodes.workflowId, wf.id))
        .all()
        .map(({ id, kind, actionId, objectTypeId, label, x, y }) => ({
          id,
          kind,
          actionId,
          objectTypeId,
          label,
          x,
          y,
        })),
    ),
    edges: byId(
      db
        .select()
        .from(workflowEdges)
        .where(eq(workflowEdges.workflowId, wf.id))
        .all()
        .map(({ id, sourceNodeId, sourcePort, targetNodeId, targetPort }) => ({
          id,
          sourceNodeId,
          sourcePort,
          targetNodeId,
          targetPort,
        })),
    ),
  };
  if (!sameDefinition(current, desired) || !hasRevision("workflow", wf.id)) {
    wf = unwrap(writeWorkflow(wf.id, desired));
  }
  console.log(`工作流已就绪：${input.name}（${wf.id}）`);
  return wf;
}

interface AwaitOptions {
  timeoutMs: number;
  pollMs?: number;
}

function terminalRow(runId: string): RunRow | undefined {
  const row = db.select().from(runs).where(eq(runs.id, runId)).get();
  return row && row.status !== "running" ? row : undefined;
}

/**
 * 等一个运行收束并**要求它成功**：非 success 与超时都抛，进程退出码因此非零。
 * 单运行脚本用它；一批运行用 awaitTerminals，那里超时要先把同批的其余运行取消掉。
 */
export async function awaitTerminal(runId: string, options: AwaitOptions): Promise<RunRow> {
  const pollMs = options.pollMs ?? 1500;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const row = terminalRow(runId);
    if (row) {
      console.log(`\n终态：${row.status}${row.error ? `（${row.error}）` : ""}`);
      console.log(`运行目录：${row.runDir}`);
      assertSmoke(
        row.status === "success",
        `运行终态是 ${row.status}${row.error ? `（${row.error}）` : ""}，冒烟要求 success`,
      );
      return row;
    }
    if (Date.now() > deadline) throw new Error(`等待运行 ${runId} 收束超时`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

interface AwaitBatchOptions extends AwaitOptions {
  /**
   * 超时时先跑它再抛：一批付费运行里有一个卡住，其余已受理的不能继续烧钱
   * （`abortRunBatch` 的语义——取消每一个并等执行器退出，它自己就会抛）。
   */
  onTimeout: (runIds: readonly string[]) => Promise<never> | Promise<void>;
}

/**
 * 等一批运行全部收束，按传入顺序返回终态行。**不判定成功与否**：并行冒烟还要逐个
 * 核对产物标记与用量隔离，成败由调用方汇总后抛。
 */
export async function awaitTerminals(
  runIds: readonly string[],
  options: AwaitBatchOptions,
): Promise<RunRow[]> {
  const pollMs = options.pollMs ?? 2000;
  const t0 = Date.now();
  for (;;) {
    const rows = runIds.map((id) => terminalRow(id));
    const done = rows.filter((row) => row !== undefined);
    process.stdout.write(
      `\r收束 ${done.length}/${runIds.length}（${Math.round((Date.now() - t0) / 1000)}s）  `,
    );
    if (done.length === runIds.length) {
      console.log();
      return done as RunRow[];
    }
    if (Date.now() - t0 > options.timeoutMs) {
      console.log();
      await options.onTimeout(runIds);
      throw new Error("等待运行收束超时");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** 节点表：label / 终态 / token / 产物 / 错误，四个脚本同一份格式。 */
export function printNodes(runId: string): void {
  console.log("\n节点：");
  for (const n of db.select().from(runNodes).where(eq(runNodes.runId, runId)).all()) {
    console.log(
      `  ${n.label.padEnd(8)} ${n.status.padEnd(8)} tokens=${totalUsageTokens(n)} 思考=${n.reasoningTokens}` +
        `${n.error ? ` 错误=${n.error}` : ""}`,
    );
    if (n.outputs) console.log(`         产物 ${JSON.stringify(n.outputs)}`);
  }
}

/**
 * 逐项核对本次运行的产物，返回「节点 id·端口名 → 绝对路径」供后续查内容。
 *
 * `required` 是本冒烟**必须**拿到的键，一个都不能少：只扫 `run_nodes.outputs` 里已有的项
 * 是不够的——回归让某个 Action 的输出压根没落进 outputs 时，扫描会静静跳过它，而输入节点
 * 物化出来的那份文件已经让「至少有产物」成立（Codex 对本 PR 的三轮复审）。分支 Action 只
 * 点名本次该走的那个出口的端口：另一个出口的产物本来就不该存在。
 *
 * 键用节点 id 而不是标签：`run_nodes.label` 对 Action 节点存的是 Action 名而不是画布标签，
 * 拿标签当键的断言实测会漏（本记录的落地段）。引擎自己也做一次落盘检查
 * （`collectArtifacts`），冒烟再独立看一眼盘：`run_nodes.outputs` 记的是本轮真实生效的路径
 *（重入的第 N 轮带 `rounds/` 前缀），所以路径从它读，不要自己拼。
 */
export function assertDeclaredArtifacts(
  runId: string,
  required: readonly string[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const node of db.select().from(runNodes).where(eq(runNodes.runId, runId)).all()) {
    for (const [portName, value] of Object.entries(node.outputs ?? {})) {
      const file = (value as { kind?: string; file?: { path?: string } } | null)?.file;
      if ((value as { kind?: string } | null)?.kind !== "file" || !file?.path) continue;
      const abs = path.join(DATA_DIR, file.path);
      assertSmoke(fs.existsSync(abs), `节点「${node.label}」声明的产物不在盘上：${abs}`);
      assertSmoke(fs.statSync(abs).size > 0, `节点「${node.label}」的产物是空文件：${abs}`);
      found.set(`${node.nodeId}·${portName}`, abs);
      console.log(`  产物 ${node.label}·${portName} → ${file.path}`);
    }
  }
  for (const key of required) {
    assertSmoke(
      found.has(key),
      `本次运行少了必须的产物「${key}」；实际只有：${[...found.keys()].join("、") || "（一份都没有）"}`,
    );
  }
  return found;
}

/**
 * 事件按类型分档打印，并要求**每个开过会话的轮次**都落齐 `required` 里的档。
 *
 * 不能只打印：会话事件的落库回调抛异常时 `RunProcess.#onNotification` 会吞掉它
 *（`runtime.ts` 那里的注释说明了为什么——权威副本在运行目录的 jsonl 里），于是节点照样成功、
 * 产物照样齐全，只有 `run_events` 空了；不断言就等于 `smoke-engine` 声称验的「事件落库」
 * 永远为真（Codex 对本 PR 的四轮复审）。也不能只按整次运行汇总：多 Action 的图里一个会话丢光
 * 事件、另一个会话补上同样的档，整体汇总照样通过（八轮复审），所以逐会话查——会话 id 从
 * `run_node_rounds` 取，回边重入的第二轮是另一个会话，同样要落齐。
 *
 * 默认要 `tool` 与 `session.idle` 两档：结构化输出本身就是一次工具调用、每个回合结束都会落一条
 * idle，两者与模型措辞无关；`reasoning` / `text` 看模型当轮心情，刻意不要求。
 */
export function assertEvents(
  runId: string,
  required: readonly string[] = ["tool", "session.idle"],
): void {
  const events = db.select().from(runEvents).where(eq(runEvents.runId, runId)).all();
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  console.log(`\n事件 ${events.length} 条：${[...byType].map(([t, c]) => `${t}×${c}`).join(" ")}`);

  const sessions = db
    .select()
    .from(runNodeRounds)
    .where(eq(runNodeRounds.runId, runId))
    .all()
    .filter((round) => round.sessionId !== null && round.status === "success");
  assertSmoke(sessions.length > 0, "这次运行没有一个成功的 Action 轮次，事件断言无从谈起");
  for (const round of sessions) {
    const mine = events.filter((e) => e.sessionId === round.sessionId);
    for (const type of required) {
      assertSmoke(
        mine.some((e) => e.type === type),
        `会话 ${round.sessionId}（节点 ${round.nodeId} 第 ${round.round} 轮）没有一条 ${type} 事件：事件没有实时落库`,
      );
    }
  }
}
