/**
 * 图能力端到端冒烟（M2 验收）：一张图同时压扇出、汇总、具名出口与回边重入。
 *
 *   需求 ──> 起草 ──┬──> 评委甲 ──┐
 *                   └──> 评委乙 ──┴──> 裁决 ──通过──> 产出
 *                    ^                    └──打回──┐
 *                    └────────── 回边 ─────────────┘
 *
 * 起草声明 maxReentries=1 / onExhausted=accept，裁决被要求第一轮一律「打回」，
 * 因此这张图必然走满一次循环——这就是验证目的。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-graph.ts
 * 会真实调用模型（约 8 次）并产生费用。
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
import { totalUsageTokens } from "./token-total";

const PREFIX = "图冒烟";

function upsertObjectType(name: string, kind: "text" | "file" | "json"): string {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(objectTypes).values({ id, name, kind, description: "冒烟用" }).run();
  return id;
}

interface PortSpec {
  name: string;
  objectTypeId: string;
  artifactPath?: string;
  exitName?: string;
}

function upsertAction(input: {
  name: string;
  prompt: string;
  rule: string;
  modelId: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  maxReentries?: number;
  onExhausted?: "fail" | "accept";
}): string {
  const existing = db.select().from(actions).where(eq(actions.name, input.name)).get();
  const id = existing?.id ?? crypto.randomUUID();
  const row = {
    name: input.name,
    description: "冒烟用",
    prompt: input.prompt,
    rule: input.rule,
    modelId: input.modelId,
    reasoningEffort: "low" as const,
    maxReentries: input.maxReentries ?? 0,
    onExhausted: input.onExhausted ?? ("fail" as const),
  };
  if (existing) db.update(actions).set(row).where(eq(actions.id, id)).run();
  else db.insert(actions).values({ id, ...row }).run();

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
        artifactPath: p.artifactPath ?? null,
        exitName: p.exitName ?? null,
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
  if (!model) throw new Error("找不到模型行，先跑 npm run db:seed");

  const tNeed = upsertObjectType(`${PREFIX}需求`, "text");
  const tDraft = upsertObjectType(`${PREFIX}草稿`, "file");
  const tNote = upsertObjectType(`${PREFIX}评语`, "file");

  const aDraft = upsertAction({
    name: `${PREFIX}·起草`,
    prompt: "按需求写一份不超过 6 行的中文草稿。若「意见」这一项本轮有内容，先读它，按意见改写上一轮的草稿。",
    rule: "只写草稿正文。有意见时必须逐条落实，不要原样重交。",
    modelId: model.id,
    inputs: [
      { name: "需求", objectTypeId: tNeed },
      { name: "意见", objectTypeId: tNote },
    ],
    outputs: [{ name: "草稿", objectTypeId: tDraft, artifactPath: "draft.md" }],
    maxReentries: 1,
    onExhausted: "accept",
  });
  const aCriticA = upsertAction({
    name: `${PREFIX}·评委甲`,
    prompt: "从「表达是否具体」这一个角度评草稿，写 2 到 3 条可执行的意见。",
    rule: "只评这一个角度，不要越界评别的。",
    modelId: model.id,
    inputs: [{ name: "草稿", objectTypeId: tDraft }],
    outputs: [{ name: "评语", objectTypeId: tNote, artifactPath: "critic-a.md" }],
  });
  const aCriticB = upsertAction({
    name: `${PREFIX}·评委乙`,
    prompt: "从「结构是否清楚」这一个角度评草稿，写 2 到 3 条可执行的意见。",
    rule: "只评这一个角度，不要越界评别的。",
    modelId: model.id,
    inputs: [{ name: "草稿", objectTypeId: tDraft }],
    outputs: [{ name: "评语", objectTypeId: tNote, artifactPath: "critic-b.md" }],
  });
  const aJudge = upsertAction({
    name: `${PREFIX}·裁决`,
    prompt:
      "读齐两位评委的全部评语再裁决。若本轮是第一轮，一律走「打回」并把两位的意见合并成一份可执行的修改清单；" +
      "第二轮起再按草稿质量决定走「通过」还是「打回」。",
    rule:
      "第一轮必须走「打回」，第二轮必须走「通过」——这是本工作流的验收要求，" +
      "两条都不要自行判断跳过。走「通过」时把最终裁决写进裁决书。",
    modelId: model.id,
    inputs: [{ name: "评语", objectTypeId: tNote }],
    outputs: [
      { name: "裁决书", objectTypeId: tNote, artifactPath: "verdict.md", exitName: "通过" },
      { name: "意见", objectTypeId: tNote, artifactPath: "review.md", exitName: "打回" },
    ],
  });

  const wfName = `${PREFIX}·扇出汇总与回边`;
  let wf = db.select().from(workflows).where(eq(workflows.name, wfName)).get();
  if (!wf) {
    const id = crypto.randomUUID();
    db.insert(workflows)
      .values({ id, name: wfName, description: "M2 验收：扇出 → 汇总 → 具名出口 → 回边重入" })
      .run();
    wf = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
  }
  db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
  db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();

  const nIn = crypto.randomUUID();
  const nDraft = crypto.randomUUID();
  const nA = crypto.randomUUID();
  const nB = crypto.randomUUID();
  const nJudge = crypto.randomUUID();
  const nOut = crypto.randomUUID();
  db.insert(workflowNodes)
    .values([
      { id: nIn, workflowId: wf.id, kind: "input", objectTypeId: tNeed, label: "需求", x: 0, y: 120 },
      { id: nDraft, workflowId: wf.id, kind: "action", actionId: aDraft, label: "起草", x: 220, y: 120 },
      { id: nA, workflowId: wf.id, kind: "action", actionId: aCriticA, label: "评委甲", x: 440, y: 20 },
      { id: nB, workflowId: wf.id, kind: "action", actionId: aCriticB, label: "评委乙", x: 440, y: 220 },
      { id: nJudge, workflowId: wf.id, kind: "action", actionId: aJudge, label: "裁决", x: 660, y: 120 },
      { id: nOut, workflowId: wf.id, kind: "output", objectTypeId: tNote, label: "产出", x: 880, y: 120 },
    ])
    .run();
  // 边 id 显式给定：回边判定按 id 排序遍历，固定 id 让判定结果可复现。
  db.insert(workflowEdges)
    .values([
      { id: "e1", workflowId: wf.id, sourceNodeId: nIn, sourcePort: "value", targetNodeId: nDraft, targetPort: "需求" },
      { id: "e2", workflowId: wf.id, sourceNodeId: nDraft, sourcePort: "草稿", targetNodeId: nA, targetPort: "草稿" },
      { id: "e3", workflowId: wf.id, sourceNodeId: nDraft, sourcePort: "草稿", targetNodeId: nB, targetPort: "草稿" },
      { id: "e4", workflowId: wf.id, sourceNodeId: nA, sourcePort: "评语", targetNodeId: nJudge, targetPort: "评语" },
      { id: "e5", workflowId: wf.id, sourceNodeId: nB, sourcePort: "评语", targetNodeId: nJudge, targetPort: "评语" },
      { id: "e6", workflowId: wf.id, sourceNodeId: nJudge, sourcePort: "意见", targetNodeId: nDraft, targetPort: "意见" },
      { id: "e7", workflowId: wf.id, sourceNodeId: nJudge, sourcePort: "裁决书", targetNodeId: nOut, targetPort: "value" },
    ])
    .run();
  console.log(`工作流已就绪：${wfName}（${wf.id}）`);

  const started = await startRun(wf.id, {
    [nIn]: { kind: "text", text: "写一段说明：为什么 Agent 工作流的中间产物应该落在文件里，而不是沿连线传值。" },
  });
  if (!started.ok) throw new Error(`启动失败：${JSON.stringify(started)}`);
  console.log(`运行已启动：${started.runId}`);

  const t0 = Date.now();
  for (;;) {
    const row = db.select().from(runs).where(eq(runs.id, started.runId)).get();
    if (row && row.status !== "running") {
      console.log(`\n终态：${row.status}${row.error ? `（${row.error}）` : ""}`);
      console.log(`运行目录：${row.runDir}`);
      break;
    }
    if (Date.now() - t0 > 900_000) throw new Error("等待运行收束超时");
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("\n节点：");
  for (const n of db.select().from(runNodes).where(eq(runNodes.runId, started.runId)).all()) {
    const tokens = totalUsageTokens(n);
    console.log(
      `  ${n.label.padEnd(8)} ${n.status.padEnd(8)} tokens=${tokens}` +
        `${n.error ? ` 错误=${n.error}` : ""}`,
    );
  }
  const events = db.select().from(runEvents).where(eq(runEvents.runId, started.runId)).all();
  console.log(`\n事件 ${events.length} 条`);
}

await main();
