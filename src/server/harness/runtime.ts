/**
 * 运行子进程运行时：Next 侧的 spawn、stdio JSON-RPC 驱动与生命周期收束。
 *
 * 所有权：本类创建并唯一拥有一个 harness 子进程、其 stdio 传输与 stderr 日志流。
 * 结算一次：dispose 与子进程自行退出共享第一次结算；未经 dispose 的退出视为
 * 崩溃并回调 onCrash。清理到静止：dispose 按协议 shutdown → stdin EOF →
 * SIGTERM → SIGKILL 逐级收束，直到观察到退出边沿（ADR-0007）。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/run/runtime.ts。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type {
  InitializeParams,
  InitializeResult,
  SessionNodeOptions,
  SessionOutputResult,
  SessionPromptResult,
} from "./rpc/types";

export class RunProcessError extends Error {}

/** 子进程退出边沿的事实记录。 */
export interface RunProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true 表示退出发生在 dispose 请求之后；false 即崩溃。 */
  expected: boolean;
}

export interface RunProcessSpawnOptions {
  /** runner 入口的绝对路径（TS，由 tsx 加载）。 */
  runnerEntry: string;
  /** 运行目录内组合配置的绝对路径。 */
  compositionPath: string;
  /** 子进程工作目录；按会话头 cwd 机制应指向运行工作区。 */
  cwd: string;
  /**
   * 显式注入的环境白名单，在洗刷后的父环境之上合并；
   * 凭据值只经这里进入子进程，绝不落入组合配置与日志。
   */
  env?: Record<string, string>;
  /** 子进程 stderr 追加写入的日志文件路径。 */
  stderrLogPath: string;
  /** 单个 RPC 请求的超时；默认 30 秒。生成回合不走这个超时。 */
  requestTimeoutMs?: number;
  /** 未经 dispose 的退出（崩溃）回调。 */
  onCrash?: (exit: RunProcessExit) => void;
  /**
   * 会话事件到达时的实时回调。引擎用它把事件即时落库——两条 SSE 端点都轮询
   * SQLite，事件不当场写进去，页面就要等到节点跑完才看得见。
   */
  onSessionEvent?: (sessionId: string, event: SessionEvent) => void;
}

/** 洗刷后的父环境为起点，显式白名单在其上合并。 */
export function buildChildEnv(explicit: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...explicit };
}

/** 一个会话到目前为止的用量累计。 */
export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
}

export class RunProcess {
  readonly #child: ChildProcess;
  readonly #transport: JsonRpcLineTransport;
  readonly #stderrStream: WriteStream;
  readonly #requestTimeoutMs: number;
  /**
   * usage chunk 到达即累加，原始事件不驻留内存：一次长运行的全量流式 chunk
   * 常驻 Next 堆，会随并行运行数放大到 GB 级；权威转录本来就在运行目录的
   * sessions/*.jsonl 里，进程内只需要总和与条数。
   */
  readonly #usageBySession = new Map<string, SessionUsageTotals>();
  readonly #eventCountBySession = new Map<string, number>();
  readonly #statusLog: { sessionId: string; status: "idle" | "running"; seq: number }[] = [];
  #statusSeq = 0;
  #statusWaiters: (() => void)[] = [];
  #exit: RunProcessExit | undefined;
  #exitWaiters: ((exit: RunProcessExit) => void)[] = [];
  #disposeRequested = false;
  #disposeTask: Promise<RunProcessExit> | undefined;
  readonly #onSessionEvent: ((sessionId: string, event: SessionEvent) => void) | undefined;

  private constructor(
    child: ChildProcess,
    stderrStream: WriteStream,
    options: RunProcessSpawnOptions,
  ) {
    this.#child = child;
    this.#stderrStream = stderrStream;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#onSessionEvent = options.onSessionEvent;
    if (child.stdout === null || child.stdin === null) {
      throw new RunProcessError("子进程缺少 stdio 管道");
    }
    this.#transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    this.#transport.onNotification((method, params) => this.#onNotification(method, params));
    this.#transport.start();
    child.on("exit", (code, signal) => {
      const exit: RunProcessExit = { code, signal, expected: this.#disposeRequested };
      this.#exit = exit;
      this.#transport.close();
      this.#stderrStream.end();
      const waiters = this.#exitWaiters;
      this.#exitWaiters = [];
      for (const waiter of waiters) waiter(exit);
      this.#wakeStatusWaiters();
      if (!exit.expected) options.onCrash?.(exit);
    });
  }

  /**
   * spawn 一个 runner 子进程并接好传输与 stderr 日志。
   * 入口是 TS，用 `node --import tsx` 加载：本仓库没有服务端构建步骤，
   * runner 与 Next 共享同一份 src/。
   */
  static spawn(options: RunProcessSpawnOptions): RunProcess {
    const stderrStream = createWriteStream(options.stderrLogPath, { flags: "a" });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", options.runnerEntry, options.compositionPath],
      {
        cwd: options.cwd,
        // 洗刷后的环境是一张白名单，不含 Next 注入的 NODE_ENV 之类；
        // ProcessEnv 的必填字段断言掉，子进程本就不该继承它们。
        env: buildChildEnv(options.env ?? {}) as unknown as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"] as const,
      },
    );
    child.stderr?.pipe(stderrStream, { end: false });
    // stdin 与子进程死亡竞态产生的 EPIPE 以退出边沿为真实信号。
    child.stdin?.on("error", () => {});
    return new RunProcess(child, stderrStream, options);
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get exitInfo(): RunProcessExit | undefined {
    return this.#exit;
  }

  /** 某会话的用量累计快照（usage chunk 到达时实时累加）。 */
  usageOf(sessionId: string): SessionUsageTotals {
    const totals = this.#usageBySession.get(sessionId);
    return totals
      ? { ...totals }
      : { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 };
  }

  /** 某会话已到达的事件条数（诊断用；事件本体不驻留）。 */
  eventCountOf(sessionId: string): number {
    return this.#eventCountBySession.get(sessionId) ?? 0;
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    // initialize 要等子进程完成 tsx 编译加 cordis 全树装配；并行准入放行的
    // 冷启动风暴（16 路同时 spawn）会把这一步拖过默认 30s，批量误杀刚起的运行。
    // 给它专属宽限；此后的常规 RPC 仍用默认超时。
    const result = await this.#request("initialize", params, 120_000);
    if (typeof (result as InitializeResult)?.serverInfo?.name !== "string") {
      throw new RunProcessError("initialize 响应缺少 serverInfo");
    }
    return result as InitializeResult;
  }

  async prompt(
    sessionId: string,
    contentBlocks: ContentBlock[],
    options?: { agentOptions?: AgentOptions; nodeOptions?: SessionNodeOptions },
  ): Promise<string> {
    const result = await this.#request("session/prompt", {
      sessionId,
      contentBlocks,
      ...(options?.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      ...(options?.nodeOptions === undefined ? {} : { nodeOptions: options.nodeOptions }),
    });
    const messageId = (result as SessionPromptResult)?.messageId;
    if (typeof messageId !== "string") throw new RunProcessError("session/prompt 响应缺少 messageId");
    return messageId;
  }

  /** 读取 outputSchema 会话的结构化捕获状态。 */
  async sessionOutput(sessionId: string): Promise<SessionOutputResult> {
    const result = await this.#request("session/output", { sessionId });
    if (typeof (result as SessionOutputResult)?.captured !== "boolean") {
      throw new RunProcessError("session/output 响应缺少 captured");
    }
    return result as SessionOutputResult;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#request("session/cancel", { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#request("session/close", { sessionId });
    // 会话关闭即释放它的累计条目；调用方（action.ts）在 close 之前已读走用量。
    this.#usageBySession.delete(sessionId);
    this.#eventCountBySession.delete(sessionId);
  }

  /** 已观察到的最新状态通知序号；配合 waitForStatus 界定「此后」的状态。 */
  get statusSeq(): number {
    return this.#statusSeq;
  }

  /** 等待某会话在 afterSeq 之后出现目标状态，返回命中状态通知的序号。 */
  async waitForStatus(
    sessionId: string,
    status: "idle" | "running",
    options?: { afterSeq?: number; timeoutMs?: number },
  ): Promise<number> {
    const afterSeq = options?.afterSeq ?? 0;
    const deadline = Date.now() + (options?.timeoutMs ?? 60_000);
    const find = (): number | undefined =>
      this.#statusLog.find(
        (e) => e.sessionId === sessionId && e.status === status && e.seq > afterSeq,
      )?.seq;
    for (;;) {
      const hit = find();
      if (hit !== undefined) return hit;
      if (this.#exit !== undefined) {
        throw new RunProcessError(
          `等待会话 ${sessionId} 进入 ${status} 时子进程已退出（code=${String(this.#exit.code)}）`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RunProcessError(`等待会话 ${sessionId} 进入 ${status} 超时`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 500));
        timer.unref();
        this.#statusWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * 发送一条用户消息并等待该会话回到 idle（先观察到 running 再观察到 idle）。
   * @returns inbox 准入回执 messageId
   */
  async runTurn(
    sessionId: string,
    contentBlocks: ContentBlock[],
    options?: {
      agentOptions?: AgentOptions;
      nodeOptions?: SessionNodeOptions;
      timeoutMs?: number;
    },
  ): Promise<string> {
    const startSeq = this.#statusSeq;
    const timeoutMs = options?.timeoutMs ?? 600_000;
    const deadline = Date.now() + timeoutMs;
    const messageId = await this.prompt(sessionId, contentBlocks, {
      ...(options?.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      ...(options?.nodeOptions === undefined ? {} : { nodeOptions: options.nodeOptions }),
    });
    const runningSeq = await this.waitForStatus(sessionId, "running", {
      afterSeq: startSeq,
      timeoutMs,
    });
    await this.waitForStatus(sessionId, "idle", {
      afterSeq: runningSeq,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    return messageId;
  }

  /** 等待子进程退出边沿；超时返回 undefined。 */
  waitExit(timeoutMs: number): Promise<RunProcessExit | undefined> {
    if (this.#exit !== undefined) return Promise.resolve(this.#exit);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref();
      this.#exitWaiters.push((exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
  }

  /** 绕过收束阶梯直接对子进程发信号；崩溃隔离测试用。 */
  terminate(signal: NodeJS.Signals): void {
    this.#child.kill(signal);
  }

  /** 收束到静止；并发与重复调用共享第一次结算。 */
  dispose(): Promise<RunProcessExit> {
    this.#disposeTask ??= this.#performDispose();
    return this.#disposeTask;
  }

  async #performDispose(): Promise<RunProcessExit> {
    this.#disposeRequested = true;
    if (this.#exit !== undefined) return this.#exit;
    try {
      await this.#request("shutdown", {}, 3000);
    } catch {
      // shutdown 尽力而为：传输可能已随崩溃关闭，退出边沿才是真实信号。
    }
    let exit = await this.waitExit(3000);
    if (exit !== undefined) return exit;
    this.#child.stdin?.end();
    exit = await this.waitExit(3000);
    if (exit !== undefined) return exit;
    this.#child.kill("SIGTERM");
    exit = await this.waitExit(3000);
    if (exit !== undefined) return exit;
    this.#child.kill("SIGKILL");
    exit = await this.waitExit(3000);
    if (exit === undefined) throw new RunProcessError("SIGKILL 之后子进程仍未退出");
    return exit;
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    if (method === "session.event") {
      const sessionId = params["sessionId"];
      if (typeof sessionId !== "string") return;
      const event = params["event"] as SessionEvent;
      this.#eventCountBySession.set(
        sessionId,
        (this.#eventCountBySession.get(sessionId) ?? 0) + 1,
      );
      const chunk = (
        event as { data?: { chunk?: { type?: string; usage?: Record<string, number> } } }
      ).data?.chunk;
      if (chunk?.type === "usage" && chunk.usage) {
        const totals =
          this.#usageBySession.get(sessionId) ??
          { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 };
        totals.inputTokens += chunk.usage.inputTokens ?? 0;
        totals.outputTokens += chunk.usage.outputTokens ?? 0;
        totals.reasoningTokens += chunk.usage.reasoningTokens ?? 0;
        totals.cacheReadTokens += chunk.usage.cacheReadTokens ?? 0;
        this.#usageBySession.set(sessionId, totals);
      }
      try {
        this.#onSessionEvent?.(sessionId, event);
      } catch (err) {
        // 落库失败不该打断事件接收：会话记录的权威副本在运行目录的 jsonl 里。
        console.error("[engine] 会话事件回调失败", sessionId, err);
      }
      return;
    }
    if (method === "session.status") {
      const sessionId = params["sessionId"];
      const status = params["status"];
      if (typeof sessionId !== "string" || (status !== "idle" && status !== "running")) return;
      this.#statusSeq += 1;
      this.#statusLog.push({ sessionId, status, seq: this.#statusSeq });
      this.#wakeStatusWaiters();
    }
  }

  #wakeStatusWaiters(): void {
    const waiters = this.#statusWaiters;
    this.#statusWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async #request(method: string, params: object, timeoutMs?: number): Promise<unknown> {
    if (this.#exit !== undefined) {
      throw new RunProcessError(
        `子进程已退出（code=${String(this.#exit.code)}），无法发送 ${method}`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new RunProcessError(`${method} 请求超时`)),
      timeoutMs ?? this.#requestTimeoutMs,
    );
    timer.unref();
    try {
      return await this.#transport.request(method, params, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
