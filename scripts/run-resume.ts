/**
 * 跑一次「简历匹配评分」（M4 第二个验收案例）。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/run-resume.ts [data内岗位路径] [data内简历路径]
 * 会真实调用模型（解析 1 次 + 评委 6 次 + 汇总 1 次）并产生费用。
 * 只打印脱敏指标，不回显岗位、简历或报告正文。
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, runNodes, runs, workflowNodes, workflows } from "../src/db";
import { startRun } from "../src/server/engine/runner";
import { DATA_DIR, resolveWithinData } from "../src/server/fs-safety";
import { inspectPdfPages, readPdfPageCount } from "./resume-pdf-inspection";
import { totalUsageTokens } from "./token-total";

function fileInput(dataRelativePath: string) {
  const abs = resolveWithinData(dataRelativePath);
  if (!fs.existsSync(abs)) throw new Error("样例不存在");
  const name = path.basename(abs);
  const extension = path.extname(name).toLowerCase();
  const mime =
    extension === ".pdf"
      ? "application/pdf"
      : extension === ".md" || extension === ".markdown"
        ? "text/markdown"
        : "text/plain";
  return {
    kind: "file" as const,
    file: { path: path.relative(DATA_DIR, abs), name, mime },
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

  const jdPath = process.argv[2] ?? path.join("samples", "岗位JD示例.md");
  const resumePath = process.argv[3] ?? path.join("samples", "简历示例.md");

  const started = await startRun(wf.id, {
    [jd.id]: fileInput(jdPath),
    [resume.id]: fileInput(resumePath),
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
  console.log(`\n终态：${row!.status}${row!.error ? "（有错误，正文不回显）" : ""}`);
  console.log(`运行目录：${row!.runDir}`);

  let totalTokens = 0;
  let totalCost = 0;
  const nodeRows = db.select().from(runNodes).where(eq(runNodes.runId, started.runId)).all();
  for (const n of nodeRows) {
    const nodeTokens = totalUsageTokens(n);
    totalTokens += nodeTokens;
    totalCost += n.cost;
    console.log(
      `  ${n.label.padEnd(10)} ${n.status.padEnd(8)} tokens=${nodeTokens}` +
        ` cost=¥${n.cost.toFixed(4)}${n.error ? " error=yes" : ""}`,
    );
  }
  console.log(`  合计 tokens=${totalTokens} cost=¥${totalCost.toFixed(4)}`);

  const ws = row!.runDir ? path.join(process.cwd(), row!.runDir, "workspace") : null;
  const expectedArtifacts = [
    "job.md",
    "resume.md",
    "scores/must-have.md",
    "scores/skill-match.md",
    "scores/experience-depth.md",
    "scores/domain-fit.md",
    "scores/stability.md",
    "scores/red-flag.md",
    "report.md",
  ];
  const artifacts = expectedArtifacts.map((relativePath) => {
    const absolutePath = ws ? path.join(ws, relativePath) : "";
    return {
      path: relativePath,
      present: absolutePath !== "" && fs.existsSync(absolutePath),
      bytes: absolutePath !== "" && fs.existsSync(absolutePath) ? fs.statSync(absolutePath).size : 0,
    };
  });
  const pdfPages = ws
    ? [
        { label: "岗位JD", nodeId: jd.id, inputPath: jdPath },
        { label: "简历", nodeId: resume.id, inputPath: resumePath },
      ].flatMap(({ label, nodeId, inputPath }) => {
        if (path.extname(inputPath).toLowerCase() !== ".pdf") return [];
        const expectedPages = readPdfPageCount(resolveWithinData(inputPath));
        return [{ label, ...inspectPdfPages(ws, nodeId, expectedPages) }];
      })
    : [];
  console.log(
    JSON.stringify(
      {
        runId: started.runId,
        status: row!.status,
        nodes: {
          total: nodeRows.length,
          success: nodeRows.filter((node) => node.status === "success").length,
          failed: nodeRows.filter((node) => node.status === "failed").length,
          skipped: nodeRows.filter((node) => node.status === "skipped").length,
        },
        totalTokens,
        totalCost,
        pdfPages,
        artifacts,
      },
      null,
      2,
    ),
  );

  const invalidArtifacts = artifacts.filter((artifact) => !artifact.present || artifact.bytes === 0);
  const incompletePdfs = pdfPages.filter((inspection) => !inspection.complete);
  if (
    row!.status !== "success" ||
    invalidArtifacts.length > 0 ||
    incompletePdfs.length > 0
  ) {
    throw new Error(
      `验收未通过：status=${row!.status} invalidArtifacts=${invalidArtifacts
        .map((artifact) => artifact.path)
        .join(",") || "none"} incompletePdfPages=${incompletePdfs
        .map((inspection) => `${inspection.label}:${inspection.missingPages.join("/")}`)
        .join(",") || "none"}`,
    );
  }
}

await main();
