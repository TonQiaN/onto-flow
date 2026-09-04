/**
 * 并行运行冒烟：同一个单 Action 工作流同时发起 10 次运行，验证 10 个 harness
 * 子进程并行执行、事件与用量并行落库、全部收束成功、工作区互不串号。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-parallel.ts [并发数]
 * 会真实调用模型并产生费用（每次运行一个短会话）。**任何一项检查不过即非零退出**
 *（夹具在 smoke-fixture.ts）。运行记录留在库里作为证据；不想留就逐个
 * DELETE /api/runs/<id> 或在监控台清理。
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, nodeUsage } from "../src/db";
import { cancelRun, isRunExecutionActive, startRun } from "../src/server/engine/runner";
import { abortRunBatch, admitWholeBatch } from "./batch-runs";
import { checkParallelMarker } from "./parallel-marker";
import {
  assertSmoke,
  awaitTerminals,
  requireCredential,
  requireModel,
  upsertAction,
  upsertObjectType,
  upsertWorkflow,
} from "./smoke-fixture";

const PREFIX = "并行冒烟";
const RUN_COUNT = Number(process.argv[2] ?? 10);
const INPUT_NODE_ID = "parallel-smoke-input";
const ACTION_NODE_ID = "parallel-smoke-action";
const OUTPUT_NODE_ID = "parallel-smoke-output";

async function main(): Promise<void> {
  requireCredential();
  if (!Number.isInteger(RUN_COUNT) || RUN_COUNT < 2) throw new Error("并发数必须是 ≥2 的整数");
  const model = requireModel();

  const tNeed = upsertObjectType(`${PREFIX}需求`, "text");
  const tOut = upsertObjectType(`${PREFIX}产出`, "file");

  const actionId = upsertAction({
    name: `${PREFIX}·誊写`,
    prompt:
      "先读「你要读的东西」指出的需求文件，再用 write 工具把需求原文一字不差写进 " +
      "out.md（不增不减、不加标题），确认写入成功后再调用 structured_output 报告路径。" +
      "不写文件就报告，本节点即失败。",
    rule: "只写需求原文，不解释、不加前后缀。",
    modelId: model.id,
    inputs: [{ name: "需求", objectTypeId: tNeed }],
    outputs: [{ name: "产出", objectTypeId: tOut, artifactPath: "out.md" }],
  });

  const wf = upsertWorkflow({
    name: `${PREFIX}·单节点`,
    description: "并行验收：输入 → 誊写 → 输出",
    nodes: [
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
    ],
    edges: [
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
    ],
  });
  console.log(`并发 ${RUN_COUNT} 次`);

  // 标记等长零填充：`标记-1` 是 `标记-10` 的子串，会把串号检查误报成阳性。
  const width = String(RUN_COUNT).length;
  const markers = Array.from(
    { length: RUN_COUNT },
    (_, i) => `并行冒烟标记-${String(i + 1).padStart(width, "0")}号`,
  );
  const runIds = await admitWholeBatch(
    markers.map((marker) =>
      startRun(wf.id, {
        [INPUT_NODE_ID]: { kind: "text", text: `${marker}：这是本运行的专属需求，原样誊写即可。` },
      }),
    ),
    { cancelRun, isRunExecutionActive },
  );
  console.log(`已同时启动 ${runIds.length} 个运行`);

  // 超时不能一走了之：同批其余运行都是已付费的在飞子进程，先取消并等它们退出。
  const rows = await awaitTerminals(runIds, {
    timeoutMs: 900_000,
    onTimeout: (ids) => abortRunBatch(ids, "等待运行收束超时", { cancelRun, isRunExecutionActive }),
  });

  let failed = 0;
  const startsAt: number[] = [];
  const finishesAt: number[] = [];
  rows.forEach((row, i) => {
    const id = row.id;
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
      const markerCheck = checkParallelMarker(content, markers[i], markers);
      if (!markerCheck.ok) {
        crossTalk = `（${markerCheck.error}）`;
        failed += 1;
      }
    }
    console.log(
      `  ${id.slice(0, 8)} ${row.status.padEnd(9)} 用时=${seconds}` +
        `${row.error ? ` 错误=${row.error}` : ""}${crossTalk}`,
    );
    if (row.status !== "success") failed += 1;
  });

  // 并行是这个冒烟唯一验的东西：全部成功但被引擎串行跑掉，同样不算通过。受理是同步的
  // （startRun 落库后就返回，执行异步起），单次运行又要好几秒，所以「最早收束之前全部已启动」
  // 是稳的判据，不是时序赌博。
  const overlapped =
    finishesAt.length === RUN_COUNT && Math.max(...startsAt) <= Math.min(...finishesAt);
  console.log(
    overlapped
      ? `\n并行证据：最早收束时刻之前 ${RUN_COUNT} 个运行已全部启动（同时在飞 ${RUN_COUNT} 个）。`
      : "\n启动/收束区间没有完整重叠：这批运行没有真正同时在飞。",
  );

  assertSmoke(failed === 0, `${failed} 个运行未成功`);
  assertSmoke(
    overlapped,
    `${RUN_COUNT} 个运行没有同时在飞：最晚启动 ${new Date(Math.max(...startsAt)).toISOString()}` +
      ` 晚于最早收束 ${new Date(Math.min(...finishesAt)).toISOString()}，引擎把这批运行串行化了`,
  );
  console.log("全部成功。");
}

await main();
