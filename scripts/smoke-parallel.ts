/**
 * 并行运行冒烟：同一个单 Action 工作流同时发起 10 次运行，验证 10 个 harness
 * 子进程并行执行、事件与用量并行落库、全部收束成功、工作区互不串号。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-parallel.ts [并发数]
 * 会真实调用模型并产生费用（每次运行一个短会话）。运行记录留在库里作为证据；
 * 不想留就逐个 DELETE /api/runs/<id> 或在监控台清理。
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  actions,
  db,
  type EntityKind,
  models,
  nodeUsage,
  objectTypes,
  revisions,
  runs,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import { startRun } from "../src/server/engine/runner";
import {
  createAction,
  loadActionDto,
  writeAction,
  type ActionPayload,
} from "../src/server/writers/action";
import {
  createObjectType,
  writeObjectType,
  type ObjectTypePayload,
} from "../src/server/writers/object-type";
import type { WriteResult } from "../src/server/writers/types";
import {
  createWorkflow,
  writeWorkflow,
  type EdgePayload,
  type NodePayload,
} from "../src/server/writers/workflow";

const PREFIX = "并行冒烟";
const RUN_COUNT = Number(process.argv[2] ?? 10);
const INPUT_NODE_ID = "parallel-smoke-input";
const ACTION_NODE_ID = "parallel-smoke-action";
const OUTPUT_NODE_ID = "parallel-smoke-output";

function upsertObjectType(name: string, kind: "text" | "file"): string {
  const desired: ObjectTypePayload = {
    name,
    kind,
    description: "冒烟用",
    jsonSchema: null,
  };
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

function unwrap<T>(result: WriteResult<T>): T {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
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

function normalizedAction(payload: ActionPayload): ActionPayload {
  return {
    ...payload,
    ports: [...payload.ports].sort(
      (left, right) =>
        left.direction.localeCompare(right.direction) ||
        left.position - right.position ||
        left.name.localeCompare(right.name),
    ),
    skillIds: [...payload.skillIds].sort(),
    toolIds: [...payload.toolIds].sort(),
  };
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");
  if (!Number.isInteger(RUN_COUNT) || RUN_COUNT < 2) throw new Error("并发数必须是 ≥2 的整数");

  const model = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, "deepseek-official"), eq(models.modelId, "deepseek-v4-flash")))
    .get();
  if (!model) throw new Error("找不到 deepseek-official/deepseek-v4-flash 模型行，先跑 npm run db:seed");

  const tNeed = upsertObjectType(`${PREFIX}需求`, "text");
  const tOut = upsertObjectType(`${PREFIX}产出`, "file");

  const actionName = `${PREFIX}·誊写`;
  const prompt =
    "先用 write 工具把需求原文一字不差写进 out.md（不增不减、不加标题），" +
    "确认写入成功后再调用 structured_output 报告路径。不写文件就报告，本节点即失败。";
  const rule = "只写需求原文，不解释、不加前后缀。";
  const desiredAction: ActionPayload = {
    name: actionName,
    description: "冒烟用",
    prompt,
    rule,
    modelId: model.id,
    reasoningEffort: "low",
    maxReentries: 0,
    onExhausted: "fail",
    ports: [
      {
        direction: "input",
        name: "需求",
        objectTypeId: tNeed,
        position: 0,
        artifactPath: null,
        exitName: null,
      },
      {
        direction: "output",
        name: "产出",
        objectTypeId: tOut,
        position: 0,
        artifactPath: "out.md",
        exitName: null,
      },
    ],
    skillIds: [],
    toolIds: [],
  };
  const existing = db.select().from(actions).where(eq(actions.name, actionName)).get();
  let actionId: string;
  if (!existing) {
    actionId = unwrap(createAction(desiredAction)).id;
  } else {
    actionId = existing.id;
    const dto = loadActionDto(actionId);
    if (!dto) throw new Error(`Action「${actionName}」读取失败`);
    const currentAction: ActionPayload = {
      name: dto.name,
      description: dto.description,
      prompt: dto.prompt,
      rule: dto.rule,
      modelId: dto.modelId,
      reasoningEffort: dto.reasoningEffort,
      maxReentries: dto.maxReentries,
      onExhausted: dto.onExhausted,
      ports: dto.ports.map((port) => ({
        direction: port.direction,
        name: port.name,
        objectTypeId: port.objectTypeId,
        position: port.position,
        artifactPath: port.artifactPath,
        exitName: port.exitName,
      })),
      skillIds: dto.skillIds,
      toolIds: dto.toolIds,
    };
    if (
      !sameDefinition(normalizedAction(currentAction), normalizedAction(desiredAction)) ||
      !hasRevision("action", actionId)
    ) {
      unwrap(writeAction(actionId, desiredAction));
    }
  }

  const wfName = `${PREFIX}·单节点`;
  const wfDescription = "并行验收：输入 → 誊写 → 输出";
  let wf = db.select().from(workflows).where(eq(workflows.name, wfName)).get();
  if (!wf) wf = unwrap(createWorkflow({ name: wfName, description: wfDescription }));
  const desiredNodes: NodePayload[] = [
    {
      id: INPUT_NODE_ID,
      kind: "input",
      actionId: null,
      objectTypeId: tNeed,
      label: "需求",
      x: 0,
      y: 0,
    },
    {
      id: ACTION_NODE_ID,
      kind: "action",
      actionId,
      objectTypeId: null,
      label: "誊写",
      x: 240,
      y: 0,
    },
    {
      id: OUTPUT_NODE_ID,
      kind: "output",
      actionId: null,
      objectTypeId: tOut,
      label: "产出",
      x: 480,
      y: 0,
    },
  ];
  const desiredEdges: EdgePayload[] = [
    {
      id: "parallel-smoke-edge-input",
      sourceNodeId: INPUT_NODE_ID,
      sourcePort: "value",
      targetNodeId: ACTION_NODE_ID,
      targetPort: "需求",
    },
    {
      id: "parallel-smoke-edge-output",
      sourceNodeId: ACTION_NODE_ID,
      sourcePort: "产出",
      targetNodeId: OUTPUT_NODE_ID,
      targetPort: "value",
    },
  ];
  const byId = <T extends { id: string }>(items: T[]) =>
    [...items].sort((left, right) => left.id.localeCompare(right.id));
  const currentDefinition = {
    name: wf.name,
    description: wf.description,
    nodes: byId(
      db
        .select()
        .from(workflowNodes)
        .where(eq(workflowNodes.workflowId, wf.id))
        .all()
        .map(({ id, kind, actionId: nodeActionId, objectTypeId, label, x, y }) => ({
          id,
          kind,
          actionId: nodeActionId,
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
  const desiredDefinition = {
    name: wfName,
    description: wfDescription,
    nodes: byId(desiredNodes),
    edges: byId(desiredEdges),
  };
  if (!sameDefinition(currentDefinition, desiredDefinition) || !hasRevision("workflow", wf.id)) {
    wf = unwrap(writeWorkflow(wf.id, desiredDefinition));
  }
  console.log(`工作流已就绪：${wfName}（${wf.id}），并发 ${RUN_COUNT} 次`);

  // 标记等长零填充：`标记-1` 是 `标记-10` 的子串，会把串号检查误报成阳性。
  const width = String(RUN_COUNT).length;
  const markers = Array.from(
    { length: RUN_COUNT },
    (_, i) => `并行冒烟标记-${String(i + 1).padStart(width, "0")}号`,
  );
  const started = await Promise.all(
    markers.map((marker) =>
      startRun(wf.id, { [INPUT_NODE_ID]: { kind: "text", text: `${marker}：这是本运行的专属需求，原样誊写即可。` } }),
    ),
  );
  const runIds: string[] = [];
  started.forEach((s, i) => {
    if (!s.ok) throw new Error(`第 ${i + 1} 个运行启动失败：${JSON.stringify(s)}`);
    runIds.push(s.runId);
  });
  console.log(`已同时启动 ${runIds.length} 个运行`);

  const t0 = Date.now();
  for (;;) {
    const rows = runIds.map((id) => db.select().from(runs).where(eq(runs.id, id)).get()!);
    const done = rows.filter((r) => r.status !== "running");
    process.stdout.write(`\r收束 ${done.length}/${RUN_COUNT}（${Math.round((Date.now() - t0) / 1000)}s）  `);
    if (done.length === RUN_COUNT) break;
    if (Date.now() - t0 > 900_000) throw new Error("等待运行收束超时");
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log();

  let failed = 0;
  const startsAt: number[] = [];
  const finishesAt: number[] = [];
  runIds.forEach((id, i) => {
    const row = db.select().from(runs).where(eq(runs.id, id)).get()!;
    startsAt.push(row.startedAt.getTime());
    if (row.finishedAt) finishesAt.push(row.finishedAt.getTime());
    const seconds = row.finishedAt
      ? `${Math.round((row.finishedAt.getTime() - row.startedAt.getTime()) / 1000)}s`
      : "-";
    let crossTalk = "";
    if (row.status === "success") {
      // 用量隔离检查：唯一键含 runId 之前，同工作流并行运行只有第一份明细能落库。
      const usageRows = db
        .select({ id: nodeUsage.messageId })
        .from(nodeUsage)
        .where(eq(nodeUsage.runId, id))
        .all().length;
      if (usageRows === 0) {
        crossTalk = "（node_usage 没有本运行的明细——并行用量被丢弃！）";
        failed += 1;
      }
    }
    if (row.status === "success" && row.runDir) {
      // 串号检查：每个运行的产物必须只含自己的专属标记。
      const artifact = path.resolve(process.cwd(), row.runDir, "workspace", "out.md");
      const content = fs.existsSync(artifact) ? fs.readFileSync(artifact, "utf8") : "";
      const own = content.includes(markers[i]);
      const others = markers.some((m, j) => j !== i && content.includes(m));
      if (!own) crossTalk = "（注意：产物未含本运行标记，人工核对）";
      if (others) {
        crossTalk = "（产物混入了其他运行的标记——工作区串号！）";
        failed += 1;
      }
    }
    console.log(
      `  ${id.slice(0, 8)} ${row.status.padEnd(9)} 用时=${seconds}` +
        `${row.error ? ` 错误=${row.error}` : ""}${crossTalk}`,
    );
    if (row.status !== "success") failed += 1;
  });

  if (finishesAt.length === RUN_COUNT && Math.max(...startsAt) <= Math.min(...finishesAt)) {
    console.log(`\n并行证据：最早收束时刻之前 ${RUN_COUNT} 个运行已全部启动（同时在飞 ${RUN_COUNT} 个）。`);
  } else {
    console.log("\n注意：启动/收束区间没有完整重叠，人工核对时间线。");
  }

  if (failed > 0) throw new Error(`${failed} 个运行未成功`);
  console.log("全部成功。");
}

await main();
