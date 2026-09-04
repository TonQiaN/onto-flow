/**
 * 图能力端到端冒烟（M2 验收）：一张图同时压扇出、汇总、具名出口与回边重入。
 *
 *   需求 ──> 起草 ──┬──> 评委甲 ──┐
 *                   └──> 评委乙 ──┴──> 裁决 ──通过──> 产出
 *                    ^                    └──打回──┐
 *                    └────────── 回边 ─────────────┘
 *
 * 起草声明 maxReentries=1 / onExhausted=accept，裁决被要求第一轮一律「打回」，
 * 因此这张图必然走满一次循环——这就是验证目的，也是收尾断言的对象：
 * 免费的单测已经覆盖回边判定与轮次记账，这里唯一的增量价值是**真模型真的报出了
 * 「打回」这个出口名、环体真的被推进了第二轮**（`docs/simplifications`）。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-graph.ts
 * 会真实调用模型（约 8 次）并产生费用。**任何一项检查不过即非零退出**。
 */
import { eq } from "drizzle-orm";
import { db, runNodeRounds } from "../src/db";
import { startRun } from "../src/server/engine/runner";
import {
  assertDeclaredArtifacts,
  assertEvents,
  assertSmoke,
  awaitTerminal,
  printNodes,
  requireCredential,
  requireModel,
  upsertAction,
  upsertObjectType,
  upsertWorkflow,
} from "./smoke-fixture";

const PREFIX = "图冒烟";
const N_IN = "graph-smoke-input";
const N_DRAFT = "graph-smoke-draft";
const N_CRITIC_A = "graph-smoke-critic-a";
const N_CRITIC_B = "graph-smoke-critic-b";
const N_JUDGE = "graph-smoke-judge";
const N_OUT = "graph-smoke-output";

async function main(): Promise<void> {
  requireCredential();
  const model = requireModel();

  const tNeed = upsertObjectType(`${PREFIX}需求`, "text");
  const tDraft = upsertObjectType(`${PREFIX}草稿`, "file");
  const tNote = upsertObjectType(`${PREFIX}评语`, "file");

  const aDraft = upsertAction({
    name: `${PREFIX}·起草`,
    prompt:
      "按需求写一份不超过 6 行的中文草稿。若「意见」这一项本轮有内容，先读它，按意见改写上一轮的草稿。",
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

  const wf = upsertWorkflow({
    name: `${PREFIX}·扇出汇总与回边`,
    description: "M2 验收：扇出 → 汇总 → 具名出口 → 回边重入",
    nodes: [
      {
        id: N_IN,
        kind: "input",
        actionId: null,
        objectTypeId: tNeed,
        label: "需求",
        x: 0,
        y: 120,
      },
      {
        id: N_DRAFT,
        kind: "action",
        actionId: aDraft,
        objectTypeId: null,
        label: "起草",
        x: 220,
        y: 120,
      },
      {
        id: N_CRITIC_A,
        kind: "action",
        actionId: aCriticA,
        objectTypeId: null,
        label: "评委甲",
        x: 440,
        y: 20,
      },
      {
        id: N_CRITIC_B,
        kind: "action",
        actionId: aCriticB,
        objectTypeId: null,
        label: "评委乙",
        x: 440,
        y: 220,
      },
      {
        id: N_JUDGE,
        kind: "action",
        actionId: aJudge,
        objectTypeId: null,
        label: "裁决",
        x: 660,
        y: 120,
      },
      {
        id: N_OUT,
        kind: "output",
        actionId: null,
        objectTypeId: tNote,
        label: "产出",
        x: 880,
        y: 120,
      },
    ],
    // 边 id 显式给定：回边判定按 id 排序遍历，固定 id 让判定结果可复现。
    edges: [
      {
        id: "e1",
        sourceNodeId: N_IN,
        sourcePort: "value",
        targetNodeId: N_DRAFT,
        targetPort: "需求",
      },
      {
        id: "e2",
        sourceNodeId: N_DRAFT,
        sourcePort: "草稿",
        targetNodeId: N_CRITIC_A,
        targetPort: "草稿",
      },
      {
        id: "e3",
        sourceNodeId: N_DRAFT,
        sourcePort: "草稿",
        targetNodeId: N_CRITIC_B,
        targetPort: "草稿",
      },
      {
        id: "e4",
        sourceNodeId: N_CRITIC_A,
        sourcePort: "评语",
        targetNodeId: N_JUDGE,
        targetPort: "评语",
      },
      {
        id: "e5",
        sourceNodeId: N_CRITIC_B,
        sourcePort: "评语",
        targetNodeId: N_JUDGE,
        targetPort: "评语",
      },
      {
        id: "e6",
        sourceNodeId: N_JUDGE,
        sourcePort: "意见",
        targetNodeId: N_DRAFT,
        targetPort: "意见",
      },
      {
        id: "e7",
        sourceNodeId: N_JUDGE,
        sourcePort: "裁决书",
        targetNodeId: N_OUT,
        targetPort: "value",
      },
    ],
  });

  const started = await startRun(wf.id, {
    [N_IN]: {
      kind: "text",
      text: "写一段说明：为什么 Agent 工作流的中间产物应该落在文件里，而不是沿连线传值。",
    },
  });
  if (!started.ok) throw new Error(`启动失败：${JSON.stringify(started)}`);
  console.log(`运行已启动：${started.runId}`);

  await awaitTerminal(started.runId, { timeoutMs: 900_000 });
  printNodes(started.runId);
  assertEvents(started.runId);

  // 回边真的走过：裁决报出过「打回」，起草因此被推进到第二轮。
  const rounds = db
    .select()
    .from(runNodeRounds)
    .where(eq(runNodeRounds.runId, started.runId))
    .all();
  const exits = rounds.filter((r) => r.nodeId === N_JUDGE).map((r) => r.exitName);
  const draftRounds = rounds.filter((r) => r.nodeId === N_DRAFT).length;
  console.log(`\n裁决走过的出口：${exits.join(" → ")}；起草共 ${draftRounds} 轮`);
  assertSmoke(exits.includes("打回"), `裁决从未报出「打回」出口（实际：${exits.join(" → ")}）`);
  assertSmoke(exits.includes("通过"), `裁决从未报出「通过」出口（实际：${exits.join(" → ")}）`);
  assertSmoke(draftRounds >= 2, `起草只有 ${draftRounds} 轮，回边重入没有真的发生`);

  // 扇出的两份评语、最后一轮的草稿，以及「通过」出口的裁决书都必须在；「打回」出口的
  // 意见不点名——最后一轮走的是「通过」，那个出口的产物本来就不该存在。
  assertDeclaredArtifacts(started.runId, [
    `${N_DRAFT}·草稿`,
    `${N_CRITIC_A}·评语`,
    `${N_CRITIC_B}·评语`,
    `${N_JUDGE}·裁决书`,
  ]);
  console.log("\n图能力冒烟通过。");
}

await main();
