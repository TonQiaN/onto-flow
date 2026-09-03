/**
 * 引擎冒烟：不经 UI 直接验证 harness 子进程能起来、能连上 DeepSeek、
 * 能写产物、能交出结构化输出、能干净收束（ADR-0006 / ADR-0007）。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-harness.ts
 * 会真实调用模型并产生费用。
 * SMOKE_EFFORT=off|low|high|max 指定思考强度（默认 high）；SMOKE_KEEP=1 保留运行目录。
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRunWorkspace, runDirPath } from "../src/server/harness/workspace";
import { launchRun } from "../src/server/harness/launch";

const t0 = Date.now();
const el = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("缺少 DEEPSEEK_API_KEY：冒烟要真实调用模型");
  }
  const effort = (process.env.SMOKE_EFFORT ?? "high") as "off" | "low" | "high" | "max";
  const keep = process.env.SMOKE_KEEP === "1";
  const runId = `run-smoke-${Date.now().toString(36)}`;
  console.log(`[${el()}] 思考强度：${effort}`);
  const ws = await createRunWorkspace({
    workflowId: "smoke",
    runId,
    instructions: "# 冒烟运行\n\n你在一个隔离的工作区里。所有产物写在当前目录下。\n",
  });
  console.log(`[${el()}] 工作区已建：${ws.runDir}`);

  const proc = await launchRun(ws, {
    onCrash: (message) => console.error("子进程崩溃：", message),
  });
  console.log(`[${el()}] 子进程已起 pid=${String(proc.pid)}，initialize 完成`);

  const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      artifact: { type: "string", description: "写出的文件名" },
      line_count: { type: "integer", description: "文件里有几行" },
    },
    required: ["artifact", "line_count"],
  };

  try {
    await proc.runTurn(
      "node-1",
      [
        {
          type: "text",
          text:
            "请在当前目录写一个文件 hello.md，正好三行：第一行 `# 你好`，第二行空行，" +
            "第三行 `OntoFlow 引擎换心冒烟通过`。写完后调用 structured_output 报告文件名与行数。",
        },
      ],
      {
        nodeOptions: { outputSchema, reasoningEffort: effort },
        timeoutMs: 300_000,
      },
    );
    console.log(`[${el()}] 一轮对话结束`);

    const out = await proc.sessionOutput("node-1");
    console.log(`[${el()}] 结构化输出：${JSON.stringify(out)}`);

    const artifact = path.join(ws.workspaceDir, "hello.md");
    console.log(`[${el()}] 产物：\n---\n${await readFile(artifact, "utf8")}---`);
    console.log(`[${el()}] 会话事件数：${proc.eventCountOf("node-1")}`);
  } finally {
    const exit = await proc.dispose();
    console.log(
      `[${el()}] 子进程收束：code=${String(exit.code)} expected=${String(exit.expected)}`,
    );
    if (keep) {
      console.log(`[${el()}] 运行目录保留：${ws.runDir}`);
    } else {
      await rm(runDirPath("smoke", runId), { recursive: true, force: true });
      console.log(`[${el()}] 运行目录已清理`);
    }
  }
}

await main();
