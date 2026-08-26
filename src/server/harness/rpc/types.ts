/**
 * OntoFlow 运行子进程的线协议：上游 dsh SDK 线协议的超集。
 *
 * 与上游一致：newline 分隔的 JSON-RPC 2.0、initialize / session/prompt / shutdown
 * 三方法与 session.event / session.status 两通知。本项目补齐：session/cancel、
 * session/close、session/output 三方法，以及 prompt 懒创建时的按会话覆盖
 * （模型路由、工具子集、作用域技能与结构化输出 schema）。
 * 上游协议无版本协商，本协议以 serverInfo.name 区分实现。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/plugins/studio-rpc/types.ts。
 */
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** 本运行时的 wire 稳定身份。 */
export const RPC_SERVER_NAME = "ontoflow-harness-runtime";

export interface InitializeParams {
  /** 记录到每个会话头的绝对工作目录。 */
  cwd: string;
  /** 默认 provider 路由；会话可经 agentOptions 覆盖。 */
  provider: string;
  /** 默认模型名；会话可经 agentOptions 覆盖。 */
  model: string;
  maxTokens?: number;
}

export interface InitializeResult {
  serverInfo: { name: string; version: string };
}

/** 经 RPC 传入、注册进 Action 会话 scope 的运行时技能。 */
export interface NodeSkillRegistration {
  name: string;
  description: string;
  whenToUse?: string;
  /** 去除 frontmatter 的技能正文。 */
  content: string;
  /** 技能目录的绝对路径，作为相对资源的解析根。 */
  resourceDir?: string;
}

/** 工具子集：对继承面做 allow/deny 交集过滤，词汇对齐上游 tools.restrict。 */
export interface NodeToolFilter {
  allow?: string[];
  deny?: string[];
}

/**
 * Action 会话的创建期组合。全部在会话创建窗口（setup）内应用，
 * 同一子进程内的会话互不可见。
 */
export interface SessionNodeOptions {
  toolFilter?: NodeToolFilter;
  skills?: NodeSkillRegistration[];
  /** 对象根 JSON Schema 子集；提供即挂载 structured_output 捕获工具与强制指令。 */
  outputSchema?: Record<string, unknown>;
  /**
   * 本会话的思考强度。上游 AgentOptions 只有 provider/model/maxTokens，没有
   * 这一项——它在 GenerateOptions 上，所以本运行时在 llm/stream 拦截点按
   * sessionId 盖上去。这是思考强度到达模型的唯一通道（ADR-0006）。
   */
  reasoningEffort?: ReasoningEffortLevel;
}

/** 思考强度档位，取值对齐上游 llm-deepseek。 */
export type ReasoningEffortLevel = "off" | "low" | "high" | "max";

export interface SessionPromptParams {
  sessionId: string;
  contentBlocks: ContentBlock[];
  /** 仅在本次 prompt 触发懒创建时生效；对已存在的会话传入会被拒绝。 */
  agentOptions?: AgentOptions;
  /** 与 agentOptions 同规则。 */
  nodeOptions?: SessionNodeOptions;
}

export interface SessionPromptResult {
  /** inbox 准入回执，不代表回合结束。 */
  messageId: string;
}

export interface SessionCancelParams {
  sessionId: string;
}
export interface SessionCancelResult {
  cancelled: true;
}
export interface SessionCloseParams {
  sessionId: string;
}
export interface SessionCloseResult {
  closed: true;
}
export interface SessionOutputParams {
  sessionId: string;
}

/** 结构化输出的当前捕获状态；未挂载 outputSchema 的会话恒为未捕获。 */
export interface SessionOutputResult {
  captured: boolean;
  value?: unknown;
}

export interface SessionEventNotification {
  sessionId: string;
  event: SessionEvent;
}

export interface SessionStatusNotification {
  sessionId: string;
  status: "idle" | "running";
}
