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
  runNodes,
  runs,
  skills,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import { DATA_DIR } from "../src/server/fs-safety";
import {
  createAction,
  loadActionDto,
  writeAction,
  type ActionPayload,
  type PortPayload,
} from "../src/server/writers/action";
import { createSkill, loadSkillDto, writeSkill, type SkillDto } from "../src/server/writers/skill";
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

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

/** 按名字找工作流，缺则建；图与三层设置字段整体替换。 */
export function upsertWorkflow(input: WorkflowFixture): WorkflowRow {
  const desired = {
    name: input.name,
    description: input.description,
    instructions: input.instructions ?? "",
    skillIds: [...(input.skillIds ?? [])].sort(),
    toolIds: [...(input.toolIds ?? [])].sort(),
    nodes: byId(input.nodes),
    edges: byId(input.edges),
  };
  let wf = db.select().from(workflows).where(eq(workflows.name, input.name)).get();
  if (!wf) {
    wf = unwrap(
      createWorkflow({
        name: input.name,
        description: input.description,
        instructions: desired.instructions,
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
 * 每个节点声明的产物都要真的在盘上，返回「节点 id·端口名 → 绝对路径」供后续查内容。
 * 键用节点 id 而不是标签：`run_nodes.label` 对 Action 节点存的是 Action 名而不是画布标签，
 * 拿标签当键的断言实测会漏（`docs/simplifications` 里这条记录的落地段）。
 * 引擎自己也做这一检查（`collectArtifacts`），冒烟再独立看一眼盘：`run_nodes.outputs`
 * 记的是本轮真实生效的路径（重入的第 N 轮带 `rounds/` 前缀），所以路径从它读，不要自己拼。
 */
export function assertDeclaredArtifacts(runId: string): Map<string, string> {
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
  assertSmoke(found.size > 0, "这次运行没有落下任何产物");
  return found;
}

/** 事件计数：按类型分档，看一眼就知道事件有没有实时落库。 */
export function printEvents(runId: string): void {
  const events = db.select().from(runEvents).where(eq(runEvents.runId, runId)).all();
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  console.log(`\n事件 ${events.length} 条：${[...byType].map(([t, c]) => `${t}×${c}`).join(" ")}`);
}
