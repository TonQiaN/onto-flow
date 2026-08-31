/**
 * 装入「LeetCode 解题验收」工作流（不花钱）：
 *
 *   题目 ──→ 解题(写 Python) ──脚本──→ 测试(出 5 个新用例并真跑)
 *              ↑                          │不通过：意见（回边）
 *              └──────────────────────────┘
 *                                         │通过：定稿脚本 ──→ 输出
 *
 * - 测试 Action 独享 run_python 工具（cordis 插件，经 node:child_process 跑
 *   python3），解题 Action 看不到它——工具面按 action_tools 引用收窄。
 * - 解题 Action 声明 maxReentries=4：最多迭代 5 版，耗尽仍不通过则运行失败。
 * - 每一轮都是全新会话，测试 Action 的提示明确要求每轮从零重写全部用例。
 *
 * 运行：npx tsx scripts/seed-leetcode.ts；之后用 scripts/run-leetcode.ts 发起运行。
 */
import { and, eq } from "drizzle-orm";
import {
  actionPorts,
  actions,
  actionTools,
  db,
  models,
  objectTypes,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";

export const LEETCODE_WORKFLOW_NAME = "LeetCode 解题验收";
export const LEETCODE_INPUT_NODE_ID = "lc-in";

const RUN_PYTHON_TOOL_CODE = `/**
 * run_python：在工作区内运行一个 Python 脚本并返回退出码与输出。
 * 组合内没有 shell 类内建工具，测试 Action 靠它真正执行测试文件。
 */
import { spawnSync } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";

export const name = "run_python";
export const inject = ["tools"];

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: "run_python",
    description: "运行工作区内的一个 Python 3 脚本，返回退出码、stdout 与 stderr（用于执行测试文件）",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        script_path: { type: "string", description: "相对当前工作区的 Python 脚本路径" },
        timeout_seconds: { type: "integer", description: "超时秒数，默认 30" },
      },
      required: ["script_path"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          exitCode: { type: "integer" },
          stdout: { type: "string" },
          stderr: { type: "string" },
        },
        required: ["exitCode", "stdout", "stderr"],
      },
      // 签名是 (args, value)：第一个是调用参数，第二个才是返回值。
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args: { script_path: string; timeout_seconds?: number }) {
      const result = spawnSync("python3", [args.script_path], {
        cwd: process.cwd(),
        timeout: Math.min(Math.max(args.timeout_seconds ?? 30, 1), 120) * 1000,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      const clip = (text: string | null | undefined) => (text ?? "").slice(0, 20000);
      return {
        exitCode: result.status ?? -1,
        stdout: clip(result.stdout),
        stderr: clip(result.error ? String(result.error) : result.stderr),
      };
    },
  });
}
`;

const WRITER_PROMPT = `你要解一道 LeetCode 算法题，题目全文见「你要读的东西」。

- 用 Python 3 标准库实现，文件里定义题目要求的 class Solution 与方法签名。
- 文件必须可以被 import 而没有任何副作用：不写 print、不写示例调用、不读输入。
- 如果「你要读的东西」里有测试意见文件（上一轮的失败反馈），先读完它，
  针对每一条失败用例修复你上一轮的解法，再写出新版本；不要凭空重来。`;

const WRITER_RULE = "只用 Python 标准库；代码要处理题目声明的边界情形（空输入、单元素等）。";

const TESTER_PROMPT = `你是严格的验收测试员。题目全文与被测脚本路径见「你要读的东西」。

1. **每一轮都从零重新设计 5 个全新的测试用例**：只依据题目原文独立推导期望值，
   不许沿用、参考或改写上一轮的测试文件，也不许用被测脚本的输出反推期望。
   用例要覆盖题面示例、边界情形（空输入、单元素、全相同元素等）与易错情形。
2. 把用例写成一个独立的测试文件（本轮产物目录下，文件名自定，如 tests.py），
   按路径加载被测脚本：
   import importlib.util
   spec = importlib.util.spec_from_file_location("solution", "<被测脚本路径>")
   mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
   每个用例断言失败时要打印输入、期望值与实际值，最后打印通过统计。
3. 用 run_python 工具真正运行这个测试文件，依据退出码与输出判定。
4. 5 个用例全部通过 → 用 read 读出被测脚本全文，原样 write 成「通过」出口的
   定稿产物，走「通过」出口。
5. 有任何用例失败或脚本报错 → 把失败用例、期望值、实际输出与具体修复建议
   写成意见文件，走「不通过」出口。`;

const TESTER_RULE =
  "判定只信 run_python 的真实运行结果，不信目测；意见必须具体到失败输入与期望值。";

function upsertObjectType(name: string, kind: "text" | "file"): string {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(objectTypes)
    .values({ id, name, kind, description: "LeetCode 解题验收工作流用" })
    .run();
  return id;
}

function upsertTool(name: string, description: string, code: string): string {
  const existing = db.select().from(tools).where(eq(tools.name, name)).get();
  if (existing) {
    db.update(tools).set({ description, code }).where(eq(tools.id, existing.id)).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(tools).values({ id, name, description, code }).run();
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
  reasoningEffort: "off" | "low" | "high" | "max";
  maxReentries?: number;
  inputs: PortSpec[];
  outputs: PortSpec[];
  toolIds?: string[];
}): string {
  const existing = db.select().from(actions).where(eq(actions.name, input.name)).get();
  const id = existing?.id ?? crypto.randomUUID();
  const row = {
    name: input.name,
    description: "LeetCode 解题验收工作流用",
    prompt: input.prompt,
    rule: input.rule,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    maxReentries: input.maxReentries ?? 0,
    onExhausted: "fail" as const,
  };
  if (existing) {
    db.update(actions).set(row).where(eq(actions.id, id)).run();
  } else {
    db.insert(actions).values({ id, ...row }).run();
  }
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
  db.delete(actionTools).where(eq(actionTools.actionId, id)).run();
  for (const toolId of input.toolIds ?? []) {
    db.insert(actionTools).values({ actionId: id, toolId }).run();
  }
  return id;
}

export function seedLeetcodeWorkflow(): { workflowId: string; inputNodeId: string } {
  const model = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, "deepseek-official"), eq(models.modelId, "deepseek-v4-flash")))
    .get();
  if (!model) {
    throw new Error("找不到 deepseek-official/deepseek-v4-flash 模型行，先跑 npm run db:seed");
  }

  const tProblem = upsertObjectType("LC题目", "text");
  const tScript = upsertObjectType("LC解法脚本", "file");
  const tFeedback = upsertObjectType("LC测试意见", "file");
  const tFinal = upsertObjectType("LC定稿脚本", "file");

  const runPythonId = upsertTool(
    "run_python",
    "运行工作区内的 Python 3 脚本并返回退出码与输出",
    RUN_PYTHON_TOOL_CODE,
  );

  const writerId = upsertAction({
    name: "LC·解题",
    prompt: WRITER_PROMPT,
    rule: WRITER_RULE,
    modelId: model.id,
    reasoningEffort: "low",
    // 回边目标必须声明重入上限（ADR-0009）：最多 5 版，耗尽即运行失败。
    maxReentries: 4,
    inputs: [
      { name: "题目", objectTypeId: tProblem },
      { name: "意见", objectTypeId: tFeedback },
    ],
    outputs: [{ name: "脚本", objectTypeId: tScript, artifactPath: "solution.py" }],
  });
  const testerId = upsertAction({
    name: "LC·测试",
    prompt: TESTER_PROMPT,
    rule: TESTER_RULE,
    modelId: model.id,
    reasoningEffort: "low",
    inputs: [
      { name: "题目", objectTypeId: tProblem },
      { name: "脚本", objectTypeId: tScript },
    ],
    outputs: [
      { name: "定稿", objectTypeId: tFinal, artifactPath: "final-solution.py", exitName: "通过" },
      { name: "意见", objectTypeId: tFeedback, artifactPath: "feedback.md", exitName: "不通过" },
    ],
    toolIds: [runPythonId],
  });

  let wf = db.select().from(workflows).where(eq(workflows.name, LEETCODE_WORKFLOW_NAME)).get();
  if (!wf) {
    const id = crypto.randomUUID();
    db.insert(workflows)
      .values({
        id,
        name: LEETCODE_WORKFLOW_NAME,
        description: "解题与测试互审的循环：测试每轮重写用例并真跑，通过才产出定稿脚本",
      })
      .run();
    wf = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
  }
  db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
  db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();
  db.insert(workflowNodes)
    .values([
      { id: LEETCODE_INPUT_NODE_ID, workflowId: wf.id, kind: "input", objectTypeId: tProblem, label: "题目", x: 0, y: 120 },
      { id: "lc-write", workflowId: wf.id, kind: "action", actionId: writerId, label: "解题", x: 260, y: 40 },
      { id: "lc-test", workflowId: wf.id, kind: "action", actionId: testerId, label: "测试", x: 540, y: 120 },
      { id: "lc-out", workflowId: wf.id, kind: "output", objectTypeId: tFinal, label: "定稿", x: 820, y: 120 },
    ])
    .run();
  db.insert(workflowEdges)
    .values([
      // classifyEdges 的 DFS 按边 id 排序遍历；e1 < e2 保证从题目先走到「解题」，
      // 这样环的方向才是 测试→解题 为回边。id 前缀就是遍历顺序的一部分，别改。
      { id: "lc-e1-problem-write", workflowId: wf.id, sourceNodeId: LEETCODE_INPUT_NODE_ID, sourcePort: "value", targetNodeId: "lc-write", targetPort: "题目" },
      { id: "lc-e2-problem-test", workflowId: wf.id, sourceNodeId: LEETCODE_INPUT_NODE_ID, sourcePort: "value", targetNodeId: "lc-test", targetPort: "题目" },
      { id: "lc-e3-script", workflowId: wf.id, sourceNodeId: "lc-write", sourcePort: "脚本", targetNodeId: "lc-test", targetPort: "脚本" },
      // 回边：不通过的意见流回解题节点，触发下一轮（ADR-0009）。
      { id: "lc-e4-feedback", workflowId: wf.id, sourceNodeId: "lc-test", sourcePort: "意见", targetNodeId: "lc-write", targetPort: "意见" },
      { id: "lc-e5-final", workflowId: wf.id, sourceNodeId: "lc-test", sourcePort: "定稿", targetNodeId: "lc-out", targetPort: "value" },
    ])
    .run();
  return { workflowId: wf.id, inputNodeId: LEETCODE_INPUT_NODE_ID };
}

// 直接执行时装入；被 run-leetcode.ts import 时由调用方决定何时装入。
if (process.argv[1]?.endsWith("seed-leetcode.ts")) {
  const { workflowId } = seedLeetcodeWorkflow();
  console.log(`工作流已就绪：${LEETCODE_WORKFLOW_NAME}（${workflowId}）`);
}
