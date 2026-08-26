/**
 * 在一个已 boot 的 harness Context 上服务 JSON-RPC 方法。
 *
 * 上游 dsh 的 packages/sdk/server/src/server.ts 是原型（MIT，见
 * THIRD_PARTY_NOTICES.md）。相对上游的差异：补齐 session/cancel、session/close
 * 与 session/output；prompt 支持懒创建时的 agentOptions 覆盖与 nodeOptions 会话
 * 组合（结构化输出、工具子集、作用域技能）；不转发 subagent 通知。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/plugins/studio-rpc/server.ts。
 */
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle, AgentOptions } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import * as LlmDeepSeek from "@deepseek-ai/dsh-llm-deepseek";
import type { JsonRpcTransportPeer } from "@deepseek-ai/dsh-sdk-protocol";
import { assertObjectJsonSchema } from "@deepseek-ai/dsh-tools";
// 仅为 Context.skills 的声明合并；运行时技能注册走该服务。
import type {} from "@deepseek-ai/dsh-skill";
import { attachStructuredRuntime, type StructuredAttachment } from "./structured";
import {
  RPC_SERVER_NAME,
  type InitializeParams,
  type InitializeResult,
  type SessionCancelParams,
  type SessionCancelResult,
  type SessionCloseParams,
  type SessionCloseResult,
  type SessionEventNotification,
  type SessionNodeOptions,
  type SessionOutputParams,
  type SessionOutputResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type ReasoningEffortLevel,
} from "./types";

interface SessionRecord {
  handle: AgentHandle;
  /** outputSchema 会话的结构化捕获句柄；其余会话无。 */
  structured?: StructuredAttachment;
}

/**
 * 单连接的 RPC 服务端。构造期订阅会话与 agent 生命周期事件，shutdown 时统一
 * 退订并 dispose 全部服务端拥有的会话；不支持重复 initialize。
 */
export class OntoflowRpcServer {
  private cwd = process.cwd();
  private provider = "deepseek-official";
  private model = "deepseek-v4-flash-vision-exp";
  private maxTokens: number | undefined;
  private llmFiber: { dispose(): Promise<void> } | undefined;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>();
  private readonly disposers: (() => void)[] = [];
  private shutdownTask: Promise<Record<string, never>> | undefined;
  private shuttingDown = false;

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
  ) {
    this.disposers.push(
      ctx.on("session/event", (session, event) => {
        const payload: SessionEventNotification = {
          sessionId: String(session.id),
          event,
        };
        this.transport.notify("session.event", payload);
      }),
    );
    this.disposers.push(
      ctx.on("agent/status", ({ agent, status }) => {
        this.transport.notify("session.status", {
          sessionId: String(agent.session.id),
          status,
        });
      }),
    );
  }

  /** 配置默认路由；provider 无适配器且为 deepseek-official 时挂载兜底适配器。 */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (
      params.maxTokens !== undefined &&
      (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)
    ) {
      throw new TypeError("initialize 的 maxTokens 必须是正安全整数");
    }
    this.cwd = path.resolve(params.cwd);
    this.provider = params.provider;
    this.model = params.model;
    this.maxTokens = params.maxTokens;
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== "deepseek-official") {
        throw new Error(`provider「${this.provider}」没有已注册的适配器`);
      }
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {});
    }
    return { serverInfo: { name: RPC_SERVER_NAME, version: "0.0.1" } };
  }

  /** 入队一条用户消息；未知 sessionId 懒创建会话，返回 inbox 准入回执。 */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const existing =
      this.sessions.get(params.sessionId) ?? this.sessionCreations.get(params.sessionId);
    if (
      existing !== undefined &&
      (params.agentOptions !== undefined || params.nodeOptions !== undefined)
    ) {
      throw new Error(
        `会话 ${params.sessionId} 已存在，agentOptions/nodeOptions 只在懒创建时生效`,
      );
    }
    const rec = await this.getOrCreateSession(
      params.sessionId,
      params.agentOptions,
      params.nodeOptions,
    );
    // agent-loop 单独 reload 会 dispose 掉注册表里的 agent 而本记录仍存活；
    // 滞留的 agent 会静默接受 followup，因此投递前校验注册表一致性。
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`会话 agent 已在服务端之外被 dispose：${params.sessionId}`);
    }
    const message = createUserMessage({
      content: params.contentBlocks,
      source: { kind: "user" },
    });
    rec.handle.agent.followup(message);
    return { messageId: message.id };
  }

  /** 读取 outputSchema 会话的结构化捕获状态。 */
  output(params: SessionOutputParams): SessionOutputResult {
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) throw new Error(`未知会话，无法读取输出：${params.sessionId}`);
    const captured = rec.structured?.captured();
    return captured === undefined ? { captured: false } : { captured: true, value: captured.value };
  }

  /**
   * 取消目标会话当前回合并清空待办 inbox；会话保持存活可继续接收 prompt。
   * 先等待挂起的懒创建：取消撞上创建窗口时送达新会话而不是丢失。
   */
  async cancel(params: SessionCancelParams): Promise<SessionCancelResult> {
    const pending = this.sessionCreations.get(params.sessionId);
    if (pending !== undefined) await pending.catch(() => undefined);
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) throw new Error(`未知会话，无法取消：${params.sessionId}`);
    rec.handle.agent.cancel({ kind: "user" });
    return { cancelled: true };
  }

  /** 关闭并释放单个会话：停止其 agent 循环、注销并等待静止。 */
  async close(params: SessionCloseParams): Promise<SessionCloseResult> {
    const pending = this.sessionCreations.get(params.sessionId);
    if (pending !== undefined) await pending.catch(() => undefined);
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) throw new Error(`未知会话，无法关闭：${params.sessionId}`);
    this.sessions.delete(params.sessionId);
    await rec.handle.dispose();
    return { closed: true };
  }

  /** dispose 服务端拥有的会话、兜底适配器与订阅到静止；周围 Context 保持运行。 */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown();
    return this.shutdownTask;
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.sessionCreations.values()]);
    this.sessionCreations.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    const failures: unknown[] = [];
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.();
      } catch (error) {
        failures.push(error);
      }
    }
    const teardown = await Promise.allSettled([
      ...records.map((rec) => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined
        ? []
        : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ]);
    this.llmFiber = undefined;
    failures.push(
      ...teardown
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason as unknown),
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "RPC 服务端 teardown 失败");
    return {};
  }

  /** 把一个入站请求分派到对应处理器；未知方法抛错并成为 JSON-RPC 错误响应。 */
  async handleRequest(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params as unknown as InitializeParams);
      case "session/prompt":
        return this.prompt(params as unknown as SessionPromptParams);
      case "session/output":
        return this.output(params as unknown as SessionOutputParams);
      case "session/cancel":
        return this.cancel(params as unknown as SessionCancelParams);
      case "session/close":
        return this.close(params as unknown as SessionCloseParams);
      case "shutdown":
        return this.shutdown();
      default:
        throw new Error(`未知的 RPC 方法：${method}`);
    }
  }

  private async getOrCreateSession(
    sessionId: string,
    agentOptions?: AgentOptions,
    nodeOptions?: SessionNodeOptions,
  ): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error("RPC 服务端正在关闭");
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.sessionCreations.get(sessionId);
    if (pending) return pending;
    const creation = this.createSession(sessionId, agentOptions, nodeOptions);
    this.sessionCreations.set(sessionId, creation);
    void creation.then(
      () => void this.sessionCreations.delete(sessionId),
      () => void this.sessionCreations.delete(sessionId),
    );
    return creation;
  }

  /**
   * 在会话创建窗口（setup）内组合 Action 会话的 scope：结构化输出运行时、
   * 工具子集与作用域技能。任一步失败使创建整体回滚，不发布半成品会话。
   */
  private composeNodeScope(
    agentCtx: Context,
    nodeOptions: SessionNodeOptions,
  ): StructuredAttachment | undefined {
    // wire 边界的敌对校验先行：schema 来自 RPC 参数，进入受信工具注册前先断言子集。
    if (nodeOptions.outputSchema !== undefined) assertObjectJsonSchema(nodeOptions.outputSchema);
    if (
      (nodeOptions.outputSchema !== undefined || nodeOptions.toolFilter !== undefined) &&
      agentCtx.get("tools") === undefined
    ) {
      throw new Error("组合未加载 tools 服务，无法应用 outputSchema/toolFilter");
    }
    if (nodeOptions.outputSchema !== undefined && agentCtx.get("systemPrompt") === undefined) {
      throw new Error("组合未加载 systemPrompt 服务，无法挂载结构化输出指令");
    }
    // 属性代理受 inject 声明门控，本插件只注入 agents；服务一律经 ctx.get 取用。
    const skillsService = agentCtx.get("skills");
    if (
      nodeOptions.skills !== undefined &&
      nodeOptions.skills.length > 0 &&
      skillsService === undefined
    ) {
      throw new Error("组合未加载 skills 服务，无法注册 Action 技能");
    }
    let structured: StructuredAttachment | undefined;
    if (nodeOptions.outputSchema !== undefined) {
      structured = attachStructuredRuntime(agentCtx, nodeOptions.outputSchema);
    }
    if (nodeOptions.maxSteps !== undefined) {
      // pre-step 是进入下一步前的裁决点：超预算就拒绝进入，本回合当场收束。
      // 会话没交出结构化输出，节点因此判失败——这正是我们要的结果。
      const limit = nodeOptions.maxSteps;
      agentCtx.on("agent/pre-step", async (payload, next) =>
        payload.step > limit ? { kind: "reject" } : next(),
      );
    }
    if (nodeOptions.reasoningEffort !== undefined) {
      // 思考强度到达模型的唯一通道（ADR-0006）。上游 AgentOptions 只有
      // provider/model/maxTokens；llm/stream 那层的 options 是冻结的，改不动。
      // agent/request 这个 waterfall 明说可以「替换冻结的调用配置」，且按
      // agent scope 过滤分发，注册在会话 scope 上即随会话释放。
      // ReasoningEffortId 是 branded string，档位取值本就来自上游同一套词汇，
      // 这里的断言只是把 wire 上的字面量喂回它自己的品牌类型。
      const effort = nodeOptions.reasoningEffort as unknown as LlmCallConfig["reasoningEffort"];
      agentCtx.on("agent/request", async (_payload, next) => ({
        ...(await next()),
        reasoningEffort: effort,
      }));
    }
    if (nodeOptions.toolFilter !== undefined) {
      // deny 分两层执行。restrict 层：上游对未知名字 fail-loud，而清单可能引用
      // 当前不在线的工具（如迟连 MCP 服务器的桥接工具），故先与已注册面求交，
      // 且有效过滤为空时跳过（上游拒绝 restrict({}) 的 no-op）。guard 层：以完整
      // deny 清单按名拒绝执行，使会话创建后才注册的被停用工具同样不可调用——
      // 只靠创建期快照求交会被工具注册时序击穿。allow 是定义面契约，保持 fail-loud。
      const filter = nodeOptions.toolFilter;
      const toolsService = agentCtx.get("tools");
      const fullDeny = filter.deny ?? [];
      const known = new Set(toolsService?.schemas().map((s) => s.name) ?? []);
      const knownDeny = fullDeny.filter((name) => known.has(name));
      if (filter.allow !== undefined || knownDeny.length > 0) {
        toolsService?.restrict({
          ...(filter.allow === undefined ? {} : { allow: filter.allow }),
          ...(knownDeny.length === 0 ? {} : { deny: knownDeny }),
        });
      }
      if (fullDeny.length > 0) {
        const denySet = new Set(fullDeny);
        // guard 与本会话 scope 同生命周期，随会话关闭一并释放。
        toolsService?.guard((execution) =>
          denySet.has(execution.name)
            ? `工具 ${execution.name} 已被全局设置默认停用`
            : undefined,
        );
      }
    }
    for (const skill of nodeOptions.skills ?? []) {
      skillsService?.register({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        content: skill.content,
        source: "runtime",
        ...(skill.resourceDir === undefined
          ? {}
          : { resourceBase: { kind: "directory" as const, path: skill.resourceDir } }),
      });
    }
    return structured;
  }

  private async createSession(
    sessionId: string,
    agentOptions?: AgentOptions,
    nodeOptions?: SessionNodeOptions,
  ): Promise<SessionRecord> {
    const maxTokens = agentOptions?.maxTokens ?? this.maxTokens;
    let structured: StructuredAttachment | undefined;
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: agentOptions?.provider ?? this.provider,
        model: agentOptions?.model ?? this.model,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
      ...(nodeOptions === undefined
        ? {}
        : {
            setup: (agentCtx: Context) => {
              structured = this.composeNodeScope(agentCtx, nodeOptions);
            },
          }),
    });
    const rec: SessionRecord = {
      handle,
      ...(structured === undefined ? {} : { structured }),
    };
    this.sessions.set(sessionId, rec);
    return rec;
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get("llm")?.listProviders().some((e) => e.id === provider) ?? false;
  }
}
