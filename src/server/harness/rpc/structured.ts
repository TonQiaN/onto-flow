/**
 * 会话作用域的结构化输出运行时：一次性 structured_output 工具、提示指令、
 * 终态守卫与权威结果两阶段提交。每个 Action 会话在自己的 scope 上注册真实
 * schema，并发会话互不可见，随会话销毁自动清理。
 *
 * 这是「数据面」的实现（ADR-0008）：模型必须以工具调用交出结构化结果，
 * 实质内容则写进工作区产物。
 *
 * 上游 dsh 的 packages/subagent/subagent-in-process-driver/src/structured.ts 是
 * 同一机制的原型（MIT，见 THIRD_PARTY_NOTICES.md）；未走 npm 依赖是因为那个包
 * 的运行时入口经 peer 链拖入 subagent/sandbox/jobs 等本项目未用的能力。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  ToolArgsError,
  validateJsonSchemaValue,
  type ObjectJsonSchema,
} from "@deepseek-ai/dsh-tools";

/** Action 必须调用以提交最终结果的模型可见工具名。 */
export const STRUCTURED_OUTPUT_TOOL = "structured_output";

/** 注册为该会话尾部提示段（order 190，工具指引带末尾）的强制指令。 */
export const STRUCTURED_OUTPUT_INSTRUCTION =
  "When you have your final answer, you MUST report it by calling the " +
  `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. ` +
  "Do not finish with a plain text answer: only the tool call counts as your result.";

/** 一次结构化运行的存活句柄：会话收束后读取捕获值。 */
export interface StructuredAttachment {
  captured(): { value: unknown } | undefined;
}

/**
 * 在会话创建窗口挂载作用域捕获工具、指令与强制机制；会话销毁移除全部注册。
 * @param childCtx 该会话 agent 的 scope context（setup 回调的入参）
 * @param schema 已经 assertObjectJsonSchema 断言过的受信 schema 子集
 */
export function attachStructuredRuntime(
  childCtx: Context,
  schema: ObjectJsonSchema,
): StructuredAttachment {
  /**
   * 工具体暂存的已校验值，等待各自的权威 tools/result 通知。执行对象的身份
   * 唯一标识一次完整管线：adapter callId 可跨步重复，但另一次执行永远无法
   * 命中此 WeakMap 项。最终通知无论成败都删除自己的暂存。
   */
  const staged = new WeakMap<ToolExecution, { value: unknown }>();
  /** 嵌套捕获成功后等待外层传输提交的暂存。 */
  let pending: { parent: ToolExecution["token"]; value: unknown } | undefined;
  let captured: { value: unknown } | undefined;

  const schemaEntry: ToolSchema = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      "Report your final structured result. Call this exactly once, when your answer is complete; " +
      "the arguments must match this tool's parameter schema exactly.",
    // ToolSchema.parameters 就是 wire 级 JSON Schema 对象；断言过的子集结构与其一致。
    parameters: schema as unknown as Record<string, unknown>,
  };

  childCtx.tools.register({
    ...schemaEntry,
    output: {
      schema: {
        type: "object",
        properties: { recorded: { type: "boolean", const: true } },
        required: ["recorded"],
        additionalProperties: false,
      },
      render: () => [{ type: "text", text: "Structured output recorded." }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      const violations = validateJsonSchemaValue(schema, args);
      // ToolArgsError → INVALID_ARGS 错误结果：模型在同一 turn 内自行重试。
      if (violations.length > 0) throw new ToolArgsError(violations);
      // 两阶段提交，以本次执行为键：后置 waterfall 仍可能把成功翻成错误。
      staged.set(exec, { value: args });
      exec.concludeTurn();
      return Promise.resolve({ recorded: true });
    },
  });

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  });

  // step 内终态守卫：guard 在整条 pre-execute waterfall 之后运行且单调组合
  // （只能拒绝或弃权），后注册的监听器无法复活派发。
  childCtx.tools.guard((exec) =>
    captured === undefined && pending === undefined
      ? undefined
      : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`,
  );

  // 提交观察不可变的权威结果：该通知位于完整管线与外层错误归一之后。
  childCtx.on("tools/result", function (this: unknown, exec, result) {
    if (exec.name === STRUCTURED_OUTPUT_TOOL) {
      const entry = staged.get(exec);
      if (entry === undefined) return;
      staged.delete(exec);
      if (result.isError) return;
      if (exec.parent === undefined) {
        if (captured === undefined) captured = { value: entry.value };
      } else if (captured === undefined && pending === undefined) {
        pending = { parent: exec.parent, value: entry.value };
      }
      return;
    }
    if (pending?.parent !== exec.token) return;
    const entry = pending;
    pending = undefined;
    if (result.isError) return;
    if (captured === undefined) captured = { value: entry.value };
  });

  return { captured: () => captured };
}
