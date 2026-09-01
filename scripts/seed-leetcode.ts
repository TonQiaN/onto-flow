/**
 * 装入「LeetCode 解题验收」工作流（不花钱）：
 *
 *   题目 ──→ 解题(写 Python) ──脚本──→ 测试(出 5 个新用例并真跑)
 *              ↑                          │不通过：意见（回边）
 *              └──────────────────────────┘
 *                                         │通过：定稿脚本 ──→ 输出
 *
 * - 测试 Action 独享 run_python 工具（cordis 插件，经 Harness 的 ctx.shell 与
 *   统一沙箱策略跑 python3），解题 Action 看不到它——工具面按引用收窄。
 * - 解题 Action 声明 maxReentries=4：最多迭代 5 版，耗尽仍不通过则运行失败。
 * - 每一轮都是全新会话，测试 Action 的提示明确要求每轮从零重写全部用例。
 *
 * 运行：npx tsx scripts/seed-leetcode.ts；之后用 scripts/run-leetcode.ts 发起运行。
 */
import { and, eq } from "drizzle-orm";
import {
  actions,
  db,
  type EntityKind,
  models,
  objectTypes,
  revisions,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import {
  createAction,
  loadActionDto,
  writeAction,
  type ActionPayload,
} from "../src/server/writers/action";
import {
  createObjectType,
  writeObjectType,
  type ObjectTypePayload,
} from "../src/server/writers/object-type";
import { createTool, writeTool, type ToolPayload } from "../src/server/writers/tool";
import type { WriteResult } from "../src/server/writers/types";
import {
  createWorkflow,
  writeWorkflow,
  type EdgePayload,
  type NodePayload,
} from "../src/server/writers/workflow";

export const LEETCODE_WORKFLOW_NAME = "LeetCode 解题验收";
export const LEETCODE_INPUT_NODE_ID = "lc-in";

const RUN_PYTHON_TOOL_CODE = `/**
 * run_python：在工作区内运行一个 Python 脚本并返回退出码与输出。
 * 执行必须复用 Harness 的 shell seam 与当前会话沙箱策略，不能另起裸子进程。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-shell";
import type {} from "@deepseek-ai/dsh-sandbox-policy";

export const name = "run_python";
export const inject = ["tools", "shell", "sandboxPolicy"];

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
          sandboxMode: { type: "string" },
          sandboxEnforcement: { type: "string" },
          sandboxDenied: { type: "boolean" },
        },
        required: [
          "exitCode",
          "stdout",
          "stderr",
          "sandboxMode",
          "sandboxEnforcement",
          "sandboxDenied",
        ],
      },
      // 签名是 (args, value)：第一个是调用参数，第二个才是返回值。
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(
      args: { script_path: string; timeout_seconds?: number },
      exec: ToolRunContext,
    ) {
      const segments = args.script_path.split("/");
      if (
        !/^[A-Za-z0-9._/-]+$/.test(args.script_path) ||
        args.script_path.startsWith("/") ||
        segments.includes("..") ||
        segments.includes("")
      ) {
        throw new Error("script_path 必须是工作区内仅含字母、数字、点、下划线、斜杠和连字符的相对路径");
      }
      if (!exec.agent) throw new Error("run_python 只能由 Action 会话调用");
      const sandboxPolicy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
      const result = await ctx.shell.run(ctx.shell.resolve({
        command: \`python3 -- \${args.script_path}\`,
        workdir: exec.agent.session.header.cwd,
        timeoutMs: Math.min(Math.max(args.timeout_seconds ?? 30, 1), 120) * 1000,
        stdoutMaxBytes: 64 * 1024,
        signal: exec.signal,
        sandboxPolicy,
      }));
      if (result.aborted) {
        const error = new Error("run_python 已取消");
        error.name = "AbortError";
        throw error;
      }
      if (!result.sandbox || result.sandbox.runnerFailed) {
        throw new Error("run_python 的沙箱执行器未生效，已拒绝把裸执行当成成功");
      }
      const clip = (text: string | null | undefined) => (text ?? "").slice(0, 20000);
      return {
        exitCode: result.exitCode ?? -1,
        stdout: clip(result.stdout.text),
        stderr: clip(result.stderr.text || (result.timedOut ? "运行超时" : "")),
        sandboxMode: result.sandbox.mode,
        sandboxEnforcement: result.sandbox.enforcement ?? "unknown",
        sandboxDenied: result.sandbox.denied,
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

function unwrap<T>(result: WriteResult<T>): T {
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
}

function hasRevision(kind: EntityKind, entityId: string): boolean {
  return !!db
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.entityKind, kind), eq(revisions.entityId, entityId)))
    .limit(1)
    .get();
}

function sameDefinition(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedAction(payload: ActionPayload): ActionPayload {
  return {
    ...payload,
    ports: [...payload.ports].sort(
      (left, right) =>
        left.direction.localeCompare(right.direction) ||
        left.position - right.position ||
        left.name.localeCompare(right.name),
    ),
    skillIds: [...payload.skillIds].sort(),
    toolIds: [...payload.toolIds].sort(),
  };
}

function upsertObjectType(name: string, kind: "text" | "file"): string {
  const desired: ObjectTypePayload = {
    name,
    kind,
    description: "LeetCode 解题验收工作流用",
    jsonSchema: null,
  };
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (!existing) return unwrap(createObjectType(desired)).id;
  const current: ObjectTypePayload = {
    name: existing.name,
    kind: existing.kind,
    description: existing.description,
    jsonSchema: existing.jsonSchema,
  };
  if (!sameDefinition(current, desired) || !hasRevision("object_type", existing.id)) {
    unwrap(writeObjectType(existing.id, desired));
  }
  return existing.id;
}

function upsertTool(name: string, description: string, code: string): string {
  const desired: ToolPayload = { name, description, code };
  const existing = db.select().from(tools).where(eq(tools.name, name)).get();
  if (!existing) return unwrap(createTool(desired)).id;
  const current: ToolPayload = {
    name: existing.name,
    description: existing.description,
    code: existing.code,
  };
  if (!sameDefinition(current, desired) || !hasRevision("tool", existing.id)) {
    unwrap(writeTool(existing.id, desired));
  }
  return existing.id;
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
  const ports: ActionPayload["ports"] = [
    ...input.inputs.map((port, position) => ({
      direction: "input" as const,
      name: port.name,
      objectTypeId: port.objectTypeId,
      position,
      artifactPath: null,
      exitName: null,
    })),
    ...input.outputs.map((port, position) => ({
      direction: "output" as const,
      name: port.name,
      objectTypeId: port.objectTypeId,
      position,
      artifactPath: port.artifactPath ?? null,
      exitName: port.exitName ?? null,
    })),
  ];
  const desired: ActionPayload = {
    name: input.name,
    description: "LeetCode 解题验收工作流用",
    prompt: input.prompt,
    rule: input.rule,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    maxReentries: input.maxReentries ?? 0,
    onExhausted: "fail",
    ports,
    skillIds: [],
    toolIds: input.toolIds ?? [],
  };
  const existing = db.select().from(actions).where(eq(actions.name, input.name)).get();
  if (!existing) return unwrap(createAction(desired)).id;
  const dto = loadActionDto(existing.id);
  if (!dto) throw new Error(`Action「${input.name}」读取失败`);
  const current: ActionPayload = {
    name: dto.name,
    description: dto.description,
    prompt: dto.prompt,
    rule: dto.rule,
    modelId: dto.modelId,
    reasoningEffort: dto.reasoningEffort,
    maxReentries: dto.maxReentries,
    onExhausted: dto.onExhausted,
    ports: dto.ports.map((port) => ({
      direction: port.direction,
      name: port.name,
      objectTypeId: port.objectTypeId,
      position: port.position,
      artifactPath: port.artifactPath,
      exitName: port.exitName,
    })),
    skillIds: dto.skillIds,
    toolIds: dto.toolIds,
  };
  if (
    !sameDefinition(normalizedAction(current), normalizedAction(desired)) ||
    !hasRevision("action", existing.id)
  ) {
    unwrap(writeAction(existing.id, desired));
  }
  return existing.id;
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

  const description = "解题与测试互审的循环：测试每轮重写用例并真跑，通过才产出定稿脚本";
  let wf = db.select().from(workflows).where(eq(workflows.name, LEETCODE_WORKFLOW_NAME)).get();
  if (!wf) wf = unwrap(createWorkflow({ name: LEETCODE_WORKFLOW_NAME, description }));

  const desiredNodes: NodePayload[] = [
    {
      id: LEETCODE_INPUT_NODE_ID,
      kind: "input",
      actionId: null,
      objectTypeId: tProblem,
      label: "题目",
      x: 0,
      y: 120,
    },
    {
      id: "lc-write",
      kind: "action",
      actionId: writerId,
      objectTypeId: null,
      label: "解题",
      x: 260,
      y: 40,
    },
    {
      id: "lc-test",
      kind: "action",
      actionId: testerId,
      objectTypeId: null,
      label: "测试",
      x: 540,
      y: 120,
    },
    {
      id: "lc-out",
      kind: "output",
      actionId: null,
      objectTypeId: tFinal,
      label: "定稿",
      x: 820,
      y: 120,
    },
  ];
  const desiredEdges: EdgePayload[] = [
    // classifyEdges 的 DFS 按边 id 排序遍历；e1 < e2 保证从题目先走到「解题」，
    // 这样环的方向才是 测试→解题 为回边。id 前缀就是遍历顺序的一部分，别改。
    { id: "lc-e1-problem-write", sourceNodeId: LEETCODE_INPUT_NODE_ID, sourcePort: "value", targetNodeId: "lc-write", targetPort: "题目" },
    { id: "lc-e2-problem-test", sourceNodeId: LEETCODE_INPUT_NODE_ID, sourcePort: "value", targetNodeId: "lc-test", targetPort: "题目" },
    { id: "lc-e3-script", sourceNodeId: "lc-write", sourcePort: "脚本", targetNodeId: "lc-test", targetPort: "脚本" },
    // 回边：不通过的意见流回解题节点，触发下一轮（ADR-0009）。
    { id: "lc-e4-feedback", sourceNodeId: "lc-test", sourcePort: "意见", targetNodeId: "lc-write", targetPort: "意见" },
    { id: "lc-e5-final", sourceNodeId: "lc-test", sourcePort: "定稿", targetNodeId: "lc-out", targetPort: "value" },
  ];
  const currentNodeRows = db
    .select()
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, wf.id))
    .all();
  const currentEdgeRows = db
    .select()
    .from(workflowEdges)
    .where(eq(workflowEdges.workflowId, wf.id))
    .all();
  const byId = <T extends { id: string }>(items: T[]) =>
    [...items].sort((left, right) => left.id.localeCompare(right.id));
  const currentDefinition = {
    name: wf.name,
    description: wf.description,
    nodes: byId(
      currentNodeRows.map(({ id, kind, actionId, objectTypeId, label, x, y }) => ({
        id,
        kind,
        actionId,
        objectTypeId,
        label,
        x,
        y,
      })),
    ),
    edges: byId(
      currentEdgeRows.map(
        ({ id, sourceNodeId, sourcePort, targetNodeId, targetPort }) => ({
          id,
          sourceNodeId,
          sourcePort,
          targetNodeId,
          targetPort,
        }),
      ),
    ),
  };
  const desiredDefinition = {
    name: LEETCODE_WORKFLOW_NAME,
    description,
    nodes: byId(desiredNodes),
    edges: byId(desiredEdges),
  };
  if (!sameDefinition(currentDefinition, desiredDefinition) || !hasRevision("workflow", wf.id)) {
    wf = unwrap(writeWorkflow(wf.id, desiredDefinition));
  }
  return { workflowId: wf.id, inputNodeId: LEETCODE_INPUT_NODE_ID };
}

// 直接执行时装入；被 run-leetcode.ts import 时由调用方决定何时装入。
if (process.argv[1]?.endsWith("seed-leetcode.ts")) {
  const { workflowId } = seedLeetcodeWorkflow();
  console.log(`工作流已就绪：${LEETCODE_WORKFLOW_NAME}（${workflowId}）`);
}
