/**
 * 在新架构下跑一次「采购集采计划生成」（M4 验收）。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/run-procurement.ts
 * 会真实调用模型（四个 Action）并产生费用。
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, purchasePlans, runNodes, runs, workflowNodes, workflows } from "../src/db";
import { startRun } from "../src/server/engine/runner";
import { DATA_DIR } from "../src/server/fs-safety";

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");
  const wf = db
    .select()
    .from(workflows)
    .where(eq(workflows.name, "采购集采计划生成"))
    .get();
  if (!wf) throw new Error("找不到工作流，先跑 npm run db:seed");

  const inputNode = db
    .select()
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, wf.id))
    .all()
    .find((n) => n.kind === "input");
  if (!inputNode) throw new Error("工作流没有输入节点");

  const sample = path.join(DATA_DIR, "samples", "采购需求示例.txt");
  if (!fs.existsSync(sample)) throw new Error(`示例需求文件不存在：${sample}`);

  const before = db.select().from(purchasePlans).all().length;
  const started = await startRun(wf.id, {
    [inputNode.id]: {
      kind: "file",
      file: {
        path: path.relative(DATA_DIR, sample),
        name: "采购需求示例.txt",
        mime: "text/plain",
      },
    },
  });
  if (!started.ok) throw new Error(`启动失败：${JSON.stringify(started)}`);
  console.log(`运行已启动：${started.runId}`);

  const t0 = Date.now();
  let row: typeof runs.$inferSelect | undefined;
  for (;;) {
    row = db.select().from(runs).where(eq(runs.id, started.runId)).get();
    if (row && row.status !== "running") break;
    if (Date.now() - t0 > 1_800_000) throw new Error("超时");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`\n终态：${row!.status}${row!.error ? `（${row!.error}）` : ""}`);
  console.log(`运行目录：${row!.runDir}`);

  let total = 0;
  for (const n of db.select().from(runNodes).where(eq(runNodes.runId, started.runId)).all()) {
    total += n.inputTokens + n.outputTokens;
    console.log(
      `  ${n.label.padEnd(12)} ${n.status.padEnd(8)} tokens=${n.inputTokens + n.outputTokens}` +
        `${n.error ? `\n      错误=${n.error}` : ""}`,
    );
  }
  console.log(`  合计 tokens=${total}`);

  const dir = path.join(process.cwd(), row!.runDir!, "workspace");
  console.log("\n工作区产物：");
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile()) console.log(`  ${f}  ${fs.statSync(full).size} 字节`);
  }

  const after = db.select().from(purchasePlans).all();
  console.log(`\n归档表：${before} → ${after.length} 行`);
  const latest = after[after.length - 1];
  if (latest) {
    console.log(`  最新一行：${latest.planNo} / ${latest.planTitle}`);
    console.log(`  审核结论：${latest.reviewConclusion ?? "（空）"}`);
    console.log(`  备份文件：${latest.backupPath ?? "（空）"}`);
  }
}

await main();
