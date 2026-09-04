/**
 * 引擎端到端冒烟：经真实的 startRun 跑一个两 Action 节点的线性工作流，
 * 验证工作区、子进程、产物落盘、双通道结果、事件落库与终态收束（M1 验收）。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-engine.ts
 * 会真实调用模型并产生费用。**任何一项检查不过即非零退出**（夹具在 smoke-fixture.ts）。
 * 工作流与运行都留在库里，作为可回看的证据。
 */
import { startRun } from "../src/server/engine/runner";
import {
  assertDeclaredArtifacts,
  awaitTerminal,
  printEvents,
  printNodes,
  requireCredential,
  requireModel,
  upsertAction,
  upsertObjectType,
  upsertWorkflow,
} from "./smoke-fixture";

const PREFIX = "引擎冒烟";
const N_IN = "engine-smoke-input";
const N_DRAFT = "engine-smoke-draft";
const N_SUMMARY = "engine-smoke-summary";
const N_OUT = "engine-smoke-output";

async function main(): Promise<void> {
  requireCredential();
  const model = requireModel();

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

  const wf = upsertWorkflow({
    name: `${PREFIX}·两节点线性`,
    description: "M1 验收：输入 → 起草 → 摘要 → 输出",
    nodes: [
      {
        id: N_IN,
        kind: "input",
        actionId: null,
        objectTypeId: tNeed,
        label: "需求",
        x: 0,
        y: 0,
      },
      {
        id: N_DRAFT,
        kind: "action",
        actionId: a1,
        objectTypeId: null,
        label: "起草",
        x: 240,
        y: 0,
      },
      {
        id: N_SUMMARY,
        kind: "action",
        actionId: a2,
        objectTypeId: null,
        label: "摘要",
        x: 480,
        y: 0,
      },
      {
        id: N_OUT,
        kind: "output",
        actionId: null,
        objectTypeId: tSummary,
        label: "产出",
        x: 720,
        y: 0,
      },
    ],
    edges: [
      {
        id: "engine-smoke-e1",
        sourceNodeId: N_IN,
        sourcePort: "value",
        targetNodeId: N_DRAFT,
        targetPort: "需求",
      },
      {
        id: "engine-smoke-e2",
        sourceNodeId: N_DRAFT,
        sourcePort: "草稿",
        targetNodeId: N_SUMMARY,
        targetPort: "草稿",
      },
      {
        id: "engine-smoke-e3",
        sourceNodeId: N_SUMMARY,
        sourcePort: "摘要",
        targetNodeId: N_OUT,
        targetPort: "value",
      },
    ],
  });

  const started = await startRun(wf.id, {
    [N_IN]: {
      kind: "text",
      text: "为一个本地 Agent 工作流编排工具写一段产品简介，面向工程师读者。",
    },
  });
  if (!started.ok) throw new Error(`启动失败：${JSON.stringify(started)}`);
  console.log(`运行已启动：${started.runId}`);

  await awaitTerminal(started.runId, { timeoutMs: 600_000 });
  printNodes(started.runId);
  printEvents(started.runId);
  // 两个 Action 各自声明的产物都必须在，缺一个就不算通过。
  assertDeclaredArtifacts(started.runId, [`${N_DRAFT}·草稿`, `${N_SUMMARY}·摘要`]);
  console.log("\n引擎冒烟通过。");
}

await main();
