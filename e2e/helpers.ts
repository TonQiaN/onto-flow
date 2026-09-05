import { randomUUID } from "node:crypto";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import Database from "better-sqlite3";
import type { RunGraph } from "@/lib/run-graph";

/** 一切从仓库根解析：data/ 取自 process.cwd()，换目录就是另一个库（与 src/db/index.ts 同源） */
export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "ontoflow.db");

/**
 * 直接打开本地库写合成夹具行（runs.spec.ts / parallel-ui.spec.ts 的同款模式）。
 * pragma 与 src/db/index.ts 一致：外键级联要生效，WAL 下与 dev server 并发写要等锁而不是立抛 BUSY。
 */
export function openDb(): Database.Database {
  const database = new Database(DB_PATH);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  return database;
}

/**
 * 删除名称以指定前缀开头的测试自建实体（幂等）。
 * 只会命中 e2e 前缀命名的实体，前缀之外的一行都不碰；builtin 一律跳过。
 */
export async function cleanupByPrefix(
  request: APIRequestContext,
  listPath: string,
  prefix: string,
): Promise<void> {
  // v2 起列表 GET 返回信封 { items, total, page, pageSize }；按前缀搜索并放大页长，
  // 保证一次拿全（MAX_PAGE_SIZE = 100）。
  const res = await request.get(`${listPath}?q=${encodeURIComponent(prefix)}&pageSize=100`);
  if (!res.ok()) return;
  const body = (await res.json()) as {
    items?: Array<{ id: string; name: string; builtin?: boolean }>;
  };
  const rows = body.items ?? [];
  for (const row of rows) {
    if (row.builtin) continue;
    if (!row.name.startsWith(prefix)) continue;
    await request.delete(`${listPath}/${row.id}`);
  }
}

/** 修订是多态引用、没有外键：实体经 API 删除后，按用例记下的精确 id 把历史清掉。 */
export type RevisionOwnerKind = "workflow" | "action" | "skill" | "tool" | "object_type";

export function cleanupRevisions(owners: Iterable<{ kind: RevisionOwnerKind; id: string }>): void {
  const list = [...owners];
  if (list.length === 0) return;
  for (const owner of list) {
    if (!/^[0-9a-f-]{36}$/.test(owner.id)) throw new Error(`测试实体 id 不安全：${owner.id}`);
  }
  const database = openDb();
  try {
    const remove = database.prepare(
      "delete from revisions where entity_kind = ? and entity_id = ?",
    );
    database.transaction(() => {
      for (const owner of list) remove.run(owner.kind, owner.id);
    })();
  } finally {
    database.close();
  }
}

/* ---------------------------- 夹具构造（七个库 spec 共用） ---------------------------- */

/**
 * `db:seed` 只种平台基线（内置对象类型与模型表），业务实体一律由 spec 自建
 * （DESIGN-V3 第 1 批）。下面这组构造函数就是那份自建约定：都经 REST 面创建、
 * 都返回 id、都可把修订归属登记进调用方的 owners 数组，收尾时交给
 * `cleanupByPrefix` + `cleanupRevisions`。名字由调用方带 `e2e-` 中文前缀。
 */
export interface RevisionOwner {
  kind: RevisionOwnerKind;
  id: string;
}

/** 同一秒内多次建同名实体也不撞：毫秒时间戳 + 随机尾巴 */
export function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/** Tool 契约里的 execute 模块（ADR-0017）：够跑通写入口校验，不做任何真实副作用 */
export const TOOL_EXECUTE_MODULE = `export default async function execute(args: { input: string }) {
  return { echo: args.input };
}
`;

function record(owners: RevisionOwner[] | undefined, kind: RevisionOwnerKind, id: string): string {
  owners?.push({ kind, id });
  return id;
}

/** 模型白名单的第一行——Action 必须指一个真实模型，具体是哪个与用例无关 */
export async function firstModelId(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/models");
  if (!res.ok()) throw new Error(`GET /api/models 失败：${res.status()}`);
  const rows = (await res.json()) as Array<{ id: string }>;
  const first = rows[0];
  if (!first) throw new Error("模型表为空：先跑 npm run db:seed");
  return first.id;
}

async function postJson<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.post(path, { data });
  if (!res.ok()) throw new Error(`POST ${path} 失败：${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

export interface ObjectTypeInput {
  name: string;
  kind?: "text" | "file" | "json";
  description?: string;
  jsonSchema?: string | null;
}

export async function createObjectType(
  request: APIRequestContext,
  input: ObjectTypeInput,
  owners?: RevisionOwner[],
): Promise<string> {
  const row = await postJson<{ id: string }>(request, "/api/object-types", {
    name: input.name,
    kind: input.kind ?? "text",
    description: input.description ?? "e2e 夹具",
    jsonSchema: input.jsonSchema ?? null,
  });
  return record(owners, "object_type", row.id);
}

export interface SkillInput {
  name: string;
  description?: string;
  content?: string;
  files?: Array<{ path: string; contentBase64: string }>;
}

export async function createSkill(
  request: APIRequestContext,
  input: SkillInput,
  owners?: RevisionOwner[],
): Promise<string> {
  const row = await postJson<{ id: string }>(request, "/api/skills", {
    name: input.name,
    description: input.description ?? "e2e 夹具技能",
    content: input.content ?? `# ${input.name}\n\n只在 e2e 里出现。\n`,
    ...(input.files ? { files: input.files } : {}),
  });
  return record(owners, "skill", row.id);
}

export interface ToolInput {
  name: string;
  publicName: string;
  description?: string;
  parameters?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  timeoutMs?: number | null;
  code?: string;
}

export async function createTool(
  request: APIRequestContext,
  input: ToolInput,
  owners?: RevisionOwner[],
): Promise<string> {
  const row = await postJson<{ id: string }>(request, "/api/tools", {
    name: input.name,
    publicName: input.publicName,
    description: input.description ?? "e2e 夹具 Tool",
    parameters: input.parameters ?? {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
    output: input.output ?? null,
    timeoutMs: input.timeoutMs ?? null,
    code: input.code ?? TOOL_EXECUTE_MODULE,
  });
  return record(owners, "tool", row.id);
}

/** Action 端口载荷（PUT/POST 整体替换，输入端口的产物路径与出口名归一为 null） */
export interface PortInput {
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
  position: number;
  artifactPath: string | null;
  exitName: string | null;
}

export function inputPort(name: string, objectTypeId: string, position = 0): PortInput {
  return { direction: "input", name, objectTypeId, position, artifactPath: null, exitName: null };
}

export function outputPort(
  name: string,
  objectTypeId: string,
  artifactPath: string,
  position = 0,
  exitName: string | null = null,
): PortInput {
  return { direction: "output", name, objectTypeId, position, artifactPath, exitName };
}

export interface ActionInput {
  name: string;
  description?: string;
  prompt?: string;
  rule?: string;
  modelId?: string;
  reasoningEffort?: "off" | "low" | "high" | "max";
  maxReentries?: number;
  onExhausted?: "fail" | "accept";
  ports?: PortInput[];
  preloadSkillIds?: string[];
  toolIds?: string[];
}

export async function createAction(
  request: APIRequestContext,
  input: ActionInput,
  owners?: RevisionOwner[],
): Promise<string> {
  const modelId = input.modelId ?? (await firstModelId(request));
  const row = await postJson<{ id: string }>(request, "/api/actions", {
    name: input.name,
    description: input.description ?? "e2e 夹具 Action",
    prompt: input.prompt ?? "读输入写输出",
    rule: input.rule ?? "",
    modelId,
    reasoningEffort: input.reasoningEffort ?? "low",
    maxReentries: input.maxReentries ?? 0,
    onExhausted: input.onExhausted ?? "fail",
    ports: input.ports ?? [],
    preloadSkillIds: input.preloadSkillIds ?? [],
    toolIds: input.toolIds ?? [],
  });
  return record(owners, "action", row.id);
}

export interface WorkflowInput {
  name: string;
  description?: string;
  instructions?: string;
  settings?: { toggles?: Record<string, boolean>; mcpServers?: string[] };
  skillIds?: string[];
  toolIds?: string[];
}

/** 只建工作流本体（图为空）；带图的用 createWorkflowGraph */
export async function createWorkflow(
  request: APIRequestContext,
  input: WorkflowInput,
  owners?: RevisionOwner[],
): Promise<string> {
  const row = await postJson<{ id: string }>(request, "/api/workflows", {
    name: input.name,
    description: input.description ?? "e2e 夹具工作流",
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    ...(input.skillIds === undefined ? {} : { skillIds: input.skillIds }),
    ...(input.toolIds === undefined ? {} : { toolIds: input.toolIds }),
  });
  return record(owners, "workflow", row.id);
}

/** 链上的一个 Action 节点：接上游的输入端口名 → 交下游的输出端口名 */
export interface ChainStep {
  actionId: string;
  label: string;
  inputPort: string;
  outputPort: string;
}

export interface GraphNodeInput {
  id: string;
  kind: "input" | "action" | "output";
  actionId: string | null;
  objectTypeId: string | null;
  label: string;
  x: number;
  y: number;
}

export interface GraphEdgeInput {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export interface LinearGraph {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  inputNodeId: string;
  outputNodeId: string;
  actionNodeIds: string[];
  edgeIds: string[];
}

/**
 * 输入节点 → steps 里的 Action 依次串联 → 输出节点。
 * 全图只用一种对象类型，任意两端口都能连（同名才能连，ADR-0002）。
 * steps 为空即输入直通输出——无 Action、零费用，用来验证受理与引擎生命周期。
 */
export function buildLinearGraph(input: {
  objectTypeId: string;
  steps?: ChainStep[];
  inputLabel?: string;
  outputLabel?: string;
}): LinearGraph {
  const steps = input.steps ?? [];
  const inputNodeId = randomUUID();
  const outputNodeId = randomUUID();
  const actionNodeIds = steps.map(() => randomUUID());

  const nodes: GraphNodeInput[] = [
    {
      id: inputNodeId,
      kind: "input",
      actionId: null,
      objectTypeId: input.objectTypeId,
      label: input.inputLabel ?? "输入",
      x: 0,
      y: 0,
    },
    ...steps.map((step, i) => ({
      id: actionNodeIds[i]!,
      kind: "action" as const,
      actionId: step.actionId,
      objectTypeId: null,
      label: step.label,
      x: 320 * (i + 1),
      y: 0,
    })),
    {
      id: outputNodeId,
      kind: "output",
      actionId: null,
      objectTypeId: input.objectTypeId,
      label: input.outputLabel ?? "输出",
      x: 320 * (steps.length + 1),
      y: 0,
    },
  ];

  const edges: GraphEdgeInput[] = [];
  let prevNodeId = inputNodeId;
  let prevPort = "value";
  for (const [i, step] of steps.entries()) {
    edges.push({
      id: randomUUID(),
      sourceNodeId: prevNodeId,
      sourcePort: prevPort,
      targetNodeId: actionNodeIds[i]!,
      targetPort: step.inputPort,
    });
    prevNodeId = actionNodeIds[i]!;
    prevPort = step.outputPort;
  }
  edges.push({
    id: randomUUID(),
    sourceNodeId: prevNodeId,
    sourcePort: prevPort,
    targetNodeId: outputNodeId,
    targetPort: "value",
  });

  return {
    nodes,
    edges,
    inputNodeId,
    outputNodeId,
    actionNodeIds,
    edgeIds: edges.map((e) => e.id),
  };
}

/** 建工作流并整图落库（PUT 整体替换）；返回 id 与图上每个节点/连线的 id */
export async function createWorkflowGraph(
  request: APIRequestContext,
  input: WorkflowInput & {
    objectTypeId: string;
    steps?: ChainStep[];
    inputLabel?: string;
    outputLabel?: string;
  },
  owners?: RevisionOwner[],
): Promise<LinearGraph & { workflowId: string }> {
  const workflowId = await createWorkflow(request, input, owners);
  const graph = buildLinearGraph(input);
  const res = await request.put(`/api/workflows/${workflowId}`, {
    data: {
      nodes: graph.nodes,
      edges: graph.edges,
      ...(input.skillIds === undefined ? {} : { skillIds: input.skillIds }),
      ...(input.toolIds === undefined ? {} : { toolIds: input.toolIds }),
    },
  });
  if (!res.ok())
    throw new Error(`PUT /api/workflows/${workflowId} 失败：${res.status()} ${await res.text()}`);
  return { workflowId, ...graph };
}

/* -------------------------------- 文件夹 -------------------------------- */

/** 建文件夹（parentId 省略即根级）；同级重名 409 由服务层保证 */
export async function createFolder(
  request: APIRequestContext,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  const row = await postJson<{ id: string }>(request, "/api/folders", { name, parentId });
  return row.id;
}

/** 单归属指派：folderId 传 null 即移出文件夹（变未归类） */
export async function assignToFolder(
  request: APIRequestContext,
  entityKind: "action" | "skill" | "tool" | "object_type",
  entityId: string,
  folderId: string | null,
): Promise<void> {
  const res = await request.post("/api/folders/assign", {
    data: { entityKind, entityId, folderId },
  });
  if (!res.ok()) throw new Error(`指派文件夹失败：${res.status()} ${await res.text()}`);
}

/**
 * 删掉名字以前缀开头的文件夹（幂等）。先删深的再删浅的：文件夹删除会把子文件夹上移，
 * 上移后与目标层级重名会被 409 拒绝，自底向上就没有这个问题。实体本身不会被删。
 */
export async function cleanupFoldersByPrefix(
  request: APIRequestContext,
  prefix: string,
): Promise<void> {
  const res = await request.get("/api/folders");
  if (!res.ok()) return;
  const body = (await res.json()) as {
    folders?: Array<{ id: string; name: string; parentId: string | null }>;
  };
  const all = body.folders ?? [];
  const byId = new Map(all.map((f) => [f.id, f]));
  const depth = (id: string): number => {
    let n = 0;
    for (let cur = byId.get(id); cur?.parentId; cur = byId.get(cur.parentId)) n += 1;
    return n;
  };
  const targets = all.filter((f) => f.name.startsWith(prefix));
  targets.sort((a, b) => depth(b.id) - depth(a.id));
  for (const folder of targets) await request.delete(`/api/folders/${folder.id}`);
}

/* ---------------------------- 合成运行（不经引擎、零费用） ---------------------------- */

/**
 * 合成运行夹具：直接写 runs / run_nodes / run_node_rounds，不 spawn 子进程、不花钱、时序完全可控。
 * 运行页只读受理时冻结的 `runs.graph` 与轮次行（ADR-0018），所以夹具要把这两样一起写出来。
 * 收尾用 `finishSyntheticRuns` 把 running 收口，再经 `DELETE /api/runs/[id]` 删除
 * （运行中的运行会被 409 拒绝）。
 */
export interface RunFixtureNode {
  nodeId: string;
  label: string;
  status?: "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";
  sessionId?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface RunFixtureRound {
  nodeId: string;
  round: number;
  status: "running" | "success" | "failed" | "cancelled" | "skipped";
  startedAt: number;
  finishedAt?: number | null;
  sessionId?: string | null;
  exitName?: string | null;
  error?: string | null;
  inputs?: unknown;
  outputs?: unknown;
  snapshot?: unknown;
  artifactValidation?: unknown;
}

export interface SyntheticRunInput {
  workflowId: string;
  workflowName: string;
  runId?: string;
  status?: "running" | "success" | "failed" | "cancelled";
  startedAt?: number;
  finishedAt?: number | null;
  runDir?: string | null;
  imports?: unknown;
  /** 冻结图；不给就落列默认的空图（早于 ADR-0018 的运行就是这样） */
  graph?: unknown;
  nodes?: RunFixtureNode[];
  rounds?: RunFixtureRound[];
}

export function insertSyntheticRun(input: SyntheticRunInput): string {
  const runId = input.runId ?? randomUUID();
  const startedAt = input.startedAt ?? Date.now();
  const database = openDb();
  try {
    database.transaction(() => {
      const columns = [
        "id",
        "workflow_id",
        "status",
        "workflow_name",
        "started_at",
        "finished_at",
        "run_dir",
        "imports",
      ];
      const values: unknown[] = [
        runId,
        input.workflowId,
        input.status ?? "running",
        input.workflowName,
        startedAt,
        input.finishedAt ?? null,
        input.runDir ?? null,
        input.imports == null ? null : JSON.stringify(input.imports),
      ];
      // graph 有列默认值（空图），只有夹具明确给了才写，好让「早于 ADR-0018 的运行」也可造
      if (input.graph !== undefined) {
        columns.push("graph");
        values.push(JSON.stringify(input.graph));
      }
      database
        .prepare(
          `insert into runs (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
        )
        .run(...values);

      const insertNode = database.prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, session_id, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const node of input.nodes ?? []) {
        insertNode.run(
          randomUUID(),
          runId,
          node.nodeId,
          node.label,
          node.status ?? "pending",
          node.sessionId ?? null,
          node.startedAt ?? null,
          node.finishedAt ?? null,
        );
      }

      const insertRound = database.prepare(
        "insert into run_node_rounds (id, run_id, node_id, round, session_id, status, started_at, finished_at, exit_name, error, inputs, outputs, snapshot, artifact_validation) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const round of input.rounds ?? []) {
        insertRound.run(
          randomUUID(),
          runId,
          round.nodeId,
          round.round,
          round.sessionId ?? null,
          round.status,
          round.startedAt,
          round.finishedAt ?? null,
          round.exitName ?? null,
          round.error ?? null,
          round.inputs == null ? null : JSON.stringify(round.inputs),
          round.outputs == null ? null : JSON.stringify(round.outputs),
          round.snapshot == null ? null : JSON.stringify(round.snapshot),
          round.artifactValidation == null ? null : JSON.stringify(round.artifactValidation),
        );
      }
    })();
  } finally {
    database.close();
  }
  return runId;
}

/** 把合成运行连同它的节点与仍在跑的轮次一起收口成 success（收尾删除的前提）。 */
export function finishSyntheticRuns(runIds: string[]): void {
  if (runIds.length === 0) return;
  const database = openDb();
  try {
    const now = Date.now();
    const finishRun = database.prepare(
      "update runs set status = 'success', finished_at = ? where id = ?",
    );
    const finishNodes = database.prepare(
      "update run_nodes set status = 'success', finished_at = ? where run_id = ? and status in ('pending', 'running')",
    );
    const finishRounds = database.prepare(
      "update run_node_rounds set status = 'success', finished_at = ? where run_id = ? and status = 'running'",
    );
    database.transaction(() => {
      for (const runId of runIds) {
        finishNodes.run(now, runId);
        finishRounds.run(now, runId);
        finishRun.run(now, runId);
      }
    })();
  } finally {
    database.close();
  }
}

/** 只有输入与输出两个节点、一条连线的冻结图：够画布画出两个节点与一条线。 */
export function linearRunGraph(input: {
  inputNodeId: string;
  outputNodeId: string;
  objectTypeId: string;
  objectTypeName?: string;
  inputLabel?: string;
  outputLabel?: string;
}): RunGraph {
  const type = {
    name: "value",
    objectTypeId: input.objectTypeId,
    objectTypeName: input.objectTypeName ?? "文本",
    kind: "text" as const,
    exitName: null,
    artifactPath: null,
    jsonSchema: null,
  };
  return {
    version: 1,
    nodes: [
      {
        id: input.inputNodeId,
        kind: "input",
        label: input.inputLabel ?? "输入",
        x: 0,
        y: 0,
        actionId: null,
        objectTypeId: input.objectTypeId,
        inputs: [],
        outputs: [type],
      },
      {
        id: input.outputNodeId,
        kind: "output",
        label: input.outputLabel ?? "输出",
        x: 260,
        y: 0,
        actionId: null,
        objectTypeId: input.objectTypeId,
        inputs: [type],
        outputs: [],
      },
    ],
    edges: [
      {
        id: `${input.inputNodeId}-${input.outputNodeId}`,
        sourceNodeId: input.inputNodeId,
        sourcePort: "value",
        targetNodeId: input.outputNodeId,
        targetPort: "value",
      },
    ],
  };
}
