/**
 * 引擎端到端冒烟：经真实的 startRun 跑一个两 Action 节点的线性工作流，
 * 验证工作区、子进程、产物落盘、双通道结果、事件落库与终态收束（M1 验收）。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-engine.ts
 * 会真实调用模型并产生费用。工作流与运行都留在库里，作为可回看的证据。
 */
import { and, eq } from "drizzle-orm";
import {
  actionPorts,
  actions,
  db,
  models,
  objectTypes,
  runEvents,
  runNodes,
  runs,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import { startRun } from "../src/server/engine/runner";

const PREFIX = "引擎冒烟";

function upsertObjectType(name: string, kind: "text" | "file" | "json"): string {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(objectTypes).values({ id, name, kind, description: "冒烟用" }).run();
  return id;
}

function upsertAction(input: {
  name: string;
  prompt: string;
  rule: string;
  modelId: string;
  inputs: Array<{ name: string; objectTypeId: string }>;
  outputs: Array<{ name: string; objectTypeId: string; artifactPath: string }>;
}): string {
  const existing = db.select().from(actions).where(eq(actions.name, input.name)).get();
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    db.update(actions)
      .set({ prompt: input.prompt, rule: input.rule, modelId: input.modelId })
      .where(eq(actions.id, id))
      .run();
  } else {
    db.insert(actions)
      .values({
        id,
        name: input.name,
        description: "冒烟用",
        prompt: input.prompt,
        rule: input.rule,
        modelId: input.modelId,
        reasoningEffort: "low",
      })
      .run();
  }
  db.delete(actionPorts).where(eq(actionPorts.actionId, id)).run();
  input.inputs.forEach((p, i) =>
    db
      .insert(actionPorts)
      .values({ actionId: id, direction: "input", name: p.name, objectTypeId: p.objectTypeId, position: i })
      .run(),
  );
  input.outputs.forEach((p, i) =>
    db
      .insert(actionPorts)
      .values({
        actionId: id,
        direction: "output",
        name: p.name,
        objectTypeId: p.objectTypeId,
        artifactPath: p.artifactPath,
        position: i,
      })
      .run(),
  );
  return id;
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");

  const model = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, "deepseek-official"), eq(models.modelId, "deepseek-v4-flash")))
    .get();
  if (!model) throw new Error("找不到 deepseek-official/deepseek-v4-flash 模型行，先跑 npm run db:seed");

  const tNeed = upsertObjectType(`${PREFIX}需求`, "text");
  const tDraft = upsertObjectType(`${PREFIX}草稿`, "file");
  const tSummary = upsertObjectType(`${PREFIX}摘要`, "file");

  const a1 = upsertAction({
    name: `${PREFIX}·起草`,
    prompt: "按需求写一份不超过 8 行的中文草稿。需求见下。",
    rule: "只写草稿正文，不写解释，不加标题以外的任何前后缀。",
    modelId: model.id,
    inputs: [{ name: "需求", objectTypeId: tNeed }],
    outputs: [{ name: "草稿", objectTypeId: tDraft, artifactPath: "draft.md" }],
  });
  const a2 = upsertAction({
    name: `${PREFIX}·摘要`,
    prompt: "读上游写出的草稿，用正好三行中文概括它，每行以「- 」开头。",
    rule: "三行就是三行，不多不少。不要复述草稿原文。",
    modelId: model.id,
    inputs: [{ name: "草稿", objectTypeId: tDraft }],
    outputs: [{ name: "摘要", objectTypeId: tSummary, artifactPath: "summary.md" }],
  });

  const wfName = `${PREFIX}·两节点线性`;
  let wf = db.select().from(workflows).where(eq(workflows.name, wfName)).get();
  if (!wf) {
    const id = crypto.randomUUID();
    db.insert(workflows)
      .values({ id, name: wfName, description: "M1 验收：输入 → 起草 → 摘要 → 输出" })
      .run();
    wf = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
  }
  db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
  db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();

  const nIn = crypto.randomUUID();
  const nA1 = crypto.randomUUID();
  const nA2 = crypto.randomUUID();
  const nOut = crypto.randomUUID();
  db.insert(workflowNodes)
    .values([
      { id: nIn, workflowId: wf.id, kind: "input", objectTypeId: tNeed, label: "需求", x: 0, y: 0 },
      { id: nA1, workflowId: wf.id, kind: "action", actionId: a1, label: "起草", x: 240, y: 0 },
      { id: nA2, workflowId: wf.id, kind: "action", actionId: a2, label: "摘要", x: 480, y: 0 },
      { id: nOut, workflowId: wf.id, kind: "output", objectTypeId: tSummary, label: "产出", x: 720, y: 0 },
    ])
    .run();
  db.insert(workflowEdges)
    .values([
      { workflowId: wf.id, sourceNodeId: nIn, sourcePort: "value", targetNodeId: nA1, targetPort: "需求" },
      { workflowId: wf.id, sourceNodeId: nA1, sourcePort: "草稿", targetNodeId: nA2, targetPort: "草稿" },
      { workflowId: wf.id, sourceNodeId: nA2, sourcePort: "摘要", targetNodeId: nOut, targetPort: "value" },
    ])
    .run();
  console.log(`工作流已就绪：${wfName}（${wf.id}）`);

  const started = await startRun(wf.id, {
    [nIn]: { kind: "text", text: "为一个本地 Agent 工作流编排工具写一段产品简介，面向工程师读者。" },
  });
  if (!started.ok) throw new Error(`启动失败：${JSON.stringify(started)}`);
  const runId = started.runId;
  console.log(`运行已启动：${runId}`);

  const t0 = Date.now();
  for (;;) {
    const row = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (row && row.status !== "running") {
      console.log(`\n终态：${row.status}${row.error ? `（${row.error}）` : ""}`);
      console.log(`运行目录：${row.runDir}`);
      break;
    }
    if (Date.now() - t0 > 600_000) throw new Error("等待运行收束超时");
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("\n节点：");
  for (const n of db.select().from(runNodes).where(eq(runNodes.runId, runId)).all()) {
    const tok = n.inputTokens + n.outputTokens;
    console.log(
      `  ${n.label.padEnd(6)} ${n.status.padEnd(8)} tokens=${tok} 思考=${n.reasoningTokens}` +
        `${n.error ? ` 错误=${n.error}` : ""}`,
    );
    if (n.outputs) console.log(`         产物 ${JSON.stringify(n.outputs)}`);
  }
  const events = db.select().from(runEvents).where(eq(runEvents.runId, runId)).all();
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  console.log(`\n事件 ${events.length} 条：${[...byType].map(([t, c]) => `${t}×${c}`).join(" ")}`);
}

await main();
