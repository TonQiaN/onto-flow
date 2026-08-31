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
  actionPorts,
  actions,
  db,
  models,
  nodeUsage,
  objectTypes,
  runs,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import { startRun } from "../src/server/engine/runner";

const PREFIX = "并行冒烟";
const RUN_COUNT = Number(process.argv[2] ?? 10);

function upsertObjectType(name: string, kind: "text" | "file"): string {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(objectTypes).values({ id, name, kind, description: "冒烟用" }).run();
  return id;
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
  const existing = db.select().from(actions).where(eq(actions.name, actionName)).get();
  const actionId = existing?.id ?? crypto.randomUUID();
  if (existing) {
    db.update(actions)
      .set({ prompt, rule, modelId: model.id, reasoningEffort: "low" })
      .where(eq(actions.id, actionId))
      .run();
  } else {
    db.insert(actions)
      .values({
        id: actionId,
        name: actionName,
        description: "冒烟用",
        prompt,
        rule,
        modelId: model.id,
        reasoningEffort: "low",
      })
      .run();
    db.insert(actionPorts)
      .values([
        { actionId, direction: "input", name: "需求", objectTypeId: tNeed, position: 0 },
        {
          actionId,
          direction: "output",
          name: "产出",
          objectTypeId: tOut,
          artifactPath: "out.md",
          position: 0,
        },
      ])
      .run();
  }

  const wfName = `${PREFIX}·单节点`;
  let wf = db.select().from(workflows).where(eq(workflows.name, wfName)).get();
  if (!wf) {
    const id = crypto.randomUUID();
    db.insert(workflows)
      .values({ id, name: wfName, description: "并行验收：输入 → 誊写 → 输出" })
      .run();
    wf = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
  }
  db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
  db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();
  const nIn = crypto.randomUUID();
  const nAct = crypto.randomUUID();
  const nOut = crypto.randomUUID();
  db.insert(workflowNodes)
    .values([
      { id: nIn, workflowId: wf.id, kind: "input", objectTypeId: tNeed, label: "需求", x: 0, y: 0 },
      { id: nAct, workflowId: wf.id, kind: "action", actionId, label: "誊写", x: 240, y: 0 },
      { id: nOut, workflowId: wf.id, kind: "output", objectTypeId: tOut, label: "产出", x: 480, y: 0 },
    ])
    .run();
  db.insert(workflowEdges)
    .values([
      { workflowId: wf.id, sourceNodeId: nIn, sourcePort: "value", targetNodeId: nAct, targetPort: "需求" },
      { workflowId: wf.id, sourceNodeId: nAct, sourcePort: "产出", targetNodeId: nOut, targetPort: "value" },
    ])
    .run();
  console.log(`工作流已就绪：${wfName}（${wf.id}），并发 ${RUN_COUNT} 次`);

  // 标记等长零填充：`标记-1` 是 `标记-10` 的子串，会把串号检查误报成阳性。
  const width = String(RUN_COUNT).length;
  const markers = Array.from(
    { length: RUN_COUNT },
    (_, i) => `并行冒烟标记-${String(i + 1).padStart(width, "0")}号`,
  );
  const started = await Promise.all(
    markers.map((marker) =>
      startRun(wf.id, { [nIn]: { kind: "text", text: `${marker}：这是本运行的专属需求，原样誊写即可。` } }),
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
