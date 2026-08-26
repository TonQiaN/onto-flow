/**
 * 跑一次「简历匹配评分」（M4 第二个验收案例）。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/run-resume.ts
 * 会真实调用模型（解析 1 次 + 评委 6 次 + 汇总 1 次）并产生费用。
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, runNodes, runs, workflowNodes, workflows } from "../src/db";
import { startRun } from "../src/server/engine/runner";
import { DATA_DIR } from "../src/server/fs-safety";

function fileInput(name: string) {
  const abs = path.join(DATA_DIR, "samples", name);
  if (!fs.existsSync(abs)) throw new Error(`样例不存在：${abs}`);
  return {
    kind: "file" as const,
    file: { path: path.relative(DATA_DIR, abs), name, mime: "text/markdown" },
  };
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");
  const wf = db.select().from(workflows).where(eq(workflows.name, "简历匹配评分")).get();
  if (!wf) throw new Error("找不到工作流，先跑 npx tsx scripts/seed-resume.ts");

  const inputs = db
    .select()
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, wf.id))
    .all()
    .filter((n) => n.kind === "input");
  const jd = inputs.find((n) => n.label === "岗位JD");
  const resume = inputs.find((n) => n.label === "简历");
  if (!jd || !resume) throw new Error("输入节点缺失");

  const started = await startRun(wf.id, {
    [jd.id]: fileInput("岗位JD示例.md"),
    [resume.id]: fileInput("简历示例.md"),
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
      `  ${n.label.padEnd(10)} ${n.status.padEnd(8)} tokens=${n.inputTokens + n.outputTokens}` +
        `${n.error ? `\n      错误=${n.error}` : ""}`,
    );
  }
  console.log(`  合计 tokens=${total}`);

  const ws = path.join(process.cwd(), row!.runDir!, "workspace");
  const walk = (dir: string, prefix = ""): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else console.log(`  ${prefix}${entry.name}  ${fs.statSync(full).size} 字节`);
    }
  };
  console.log("\n工作区产物：");
  walk(ws);

  const report = path.join(ws, "report.md");
  if (fs.existsSync(report)) {
    console.log("\n=== 评分报告（前 40 行） ===");
    console.log(fs.readFileSync(report, "utf8").split("\n").slice(0, 40).join("\n"));
  }
}

await main();
