/**
 * 「LeetCode 解题验收」运行脚本（真实调用模型，需要 DEEPSEEK_API_KEY）：
 *
 *   npx tsx scripts/run-leetcode.ts [并发数]     # 默认 1；3 即三个运行同时跑
 *
 * 预设题目是 LeetCode #3 无重复字符的最长子串。收束后对每个成功运行的定稿
 * 脚本再做一次本地独立验收（python3 按固定用例跑），防止“测试与解题合谋”
 * 的假通过。运行记录留在库里作为证据。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, runNodes, runs } from "../src/db";
import { DATA_DIR } from "../src/server/fs-safety";
import { startRun } from "../src/server/engine/runner";
import { seedLeetcodeWorkflow, LEETCODE_INPUT_NODE_ID } from "./seed-leetcode";
import type { PortValue } from "../src/lib/values";

const RUN_COUNT = Number(process.argv[2] ?? 1);

const PROBLEM = `LeetCode #3 无重复字符的最长子串（中等）

给定一个字符串 s，请找出其中不含有重复字符的最长子串的长度。

实现要求：class Solution 内实现方法
    def lengthOfLongestSubstring(self, s: str) -> int

示例：
- s = "abcabcbb" → 3（最长为 "abc"）
- s = "bbbbb" → 1（最长为 "b"）
- s = "pwwkew" → 3（最长为 "wke"；注意答案必须是子串，"pwke" 是子序列）

约束：0 <= len(s) <= 5 * 10^4；s 由英文字母、数字、符号和空格组成。`;

/** 本地独立验收用例：题面示例 + 边界。 */
const VERIFY_PY = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("solution", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
f = mod.Solution().lengthOfLongestSubstring
cases = [("abcabcbb", 3), ("bbbbb", 1), ("pwwkew", 3), ("", 0), ("au", 2), ("dvdf", 3), (" ", 1)]
bad = [(s, want, f(s)) for s, want in cases if f(s) != want]
for s, want, got in bad:
    print(f"FAIL input={s!r} want={want} got={got}")
print(f"{len(cases) - len(bad)}/{len(cases)} 通过")
sys.exit(1 if bad else 0)
`;

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");
  if (!Number.isInteger(RUN_COUNT) || RUN_COUNT < 1) throw new Error("并发数必须是 ≥1 的整数");

  const { workflowId } = seedLeetcodeWorkflow();
  console.log(`工作流已就绪（${workflowId}），同时发起 ${RUN_COUNT} 个运行`);

  const started = await Promise.all(
    Array.from({ length: RUN_COUNT }, () =>
      startRun(workflowId, {
        [LEETCODE_INPUT_NODE_ID]: { kind: "text", text: PROBLEM },
      }),
    ),
  );
  const runIds: string[] = [];
  started.forEach((s, i) => {
    if (!s.ok) throw new Error(`第 ${i + 1} 个运行启动失败：${JSON.stringify(s)}`);
    runIds.push(s.runId);
  });

  const t0 = Date.now();
  for (;;) {
    const rows = runIds.map((id) => db.select().from(runs).where(eq(runs.id, id)).get()!);
    const done = rows.filter((r) => r.status !== "running").length;
    process.stdout.write(
      `\r收束 ${done}/${RUN_COUNT}（${Math.round((Date.now() - t0) / 1000)}s）  `,
    );
    if (done === RUN_COUNT) break;
    if (Date.now() - t0 > 1_800_000) throw new Error("等待运行收束超时");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("\n");

  let failed = 0;
  for (const id of runIds) {
    const row = db.select().from(runs).where(eq(runs.id, id)).get()!;
    const nodes = db.select().from(runNodes).where(eq(runNodes.runId, id)).all();
    const tester = nodes.find((n) => n.nodeId === "lc-test");
    // 会话 id 带轮次后缀（node#N），据此还原测试节点实际跑到第几轮。
    const roundMatch = tester?.sessionId?.match(/#(\d+)$/);
    const roundCount = roundMatch ? Number(roundMatch[1]) : tester?.sessionId ? 1 : 0;
    const tokens = nodes.reduce(
      (sum, n) => sum + n.inputTokens + n.outputTokens + n.reasoningTokens,
      0,
    );
    const seconds = row.finishedAt
      ? `${Math.round((row.finishedAt.getTime() - row.startedAt.getTime()) / 1000)}s`
      : "-";
    console.log(
      `运行 ${id.slice(0, 8)}：${row.status} 轮次=${roundCount} 用时=${seconds} tokens=${tokens}` +
        `${row.error ? `\n  错误：${row.error}` : ""}`,
    );
    if (row.status !== "success") {
      failed += 1;
      continue;
    }

    const output = nodes.find((n) => n.nodeId === "lc-out");
    const value = (output?.outputs as Record<string, PortValue> | null)?.value;
    if (!value || value.kind !== "file") {
      console.log("  异常：输出节点没有文件产物");
      failed += 1;
      continue;
    }
    const finalPath = path.join(DATA_DIR, value.file.path);
    const verify = spawnSync("python3", ["-c", VERIFY_PY, finalPath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const verdict = verify.status === 0 ? "本地独立验收通过" : "本地独立验收失败";
    console.log(`  定稿：${value.file.path}`);
    console.log(`  ${verdict}：${(verify.stdout || verify.stderr || "").trim().split("\n").join("；")}`);
    if (verify.status !== 0) failed += 1;
  }

  if (failed > 0) throw new Error(`${failed} 个运行未通过验收`);
  console.log("\n全部运行成功且定稿脚本通过本地独立验收。");
}

await main();
