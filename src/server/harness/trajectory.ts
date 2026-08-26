/**
 * 运行详情的会话轨迹投影。
 *
 * DSH 的 session.jsonl 是可恢复会话的事实源，run_events 只是面向全局日志的摘要，
 * 因此这里直接读持久化日志并投影出展示 DTO。投影只消费 durable event；token
 * chunk 会聚合成一条运行中或中断的模型响应，并提供首 token 时间与累计 usage，
 * 不会把流式碎片重复显示成数百条记录。
 */
import fs from "node:fs";
import path from "node:path";
import {
  decodeStorageRecord,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
// 注册 llm/retry 与 llm/retry-started 的 SessionEventMap 声明合并。
import type {} from "@deepseek-ai/dsh-llm-retry";
import { DATA_DIR, resolveWithinData } from "@/server/fs-safety";

export interface TrajectoryDetail {
  label: string;
  content: string;
  format: "text" | "json";
  truncated: boolean;
}

export interface TrajectoryUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TrajectoryRecord {
  id: string;
  seq: number;
  kind: "system" | "user" | "context" | "assistant" | "tool" | "error";
  lane: "input" | "model" | "tools";
  label: string;
  summary: string;
  turn: number | null;
  step: number | null;
  startedAt: number;
  finishedAt: number | null;
  state: "complete" | "running" | "error";
  callId?: string;
  toolName?: string;
  details: TrajectoryDetail[];
  usage?: TrajectoryUsage;
}

export type TrajectorySessionStatus =
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "blocked"
  | "max-tokens"
  | "interrupted"
  | "unknown";

export interface TrajectorySession {
  id: string;
  round: number;
  status: TrajectorySessionStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  provider: string;
  model: string;
  contextWindow: number | null;
  turns: number;
  steps: number;
  calls: number;
  records: TrajectoryRecord[];
}

export type AgentTrajectoryResponse =
  | { available: true; sessions: TrajectorySession[] }
  | {
      available: false;
      reason: "not-recorded" | "cleaned";
      sessions: [];
    };

export interface ReadAgentTrajectoryOptions {
  /** runs.run_dir 原值；它相对仓库根，而不是相对 DATA_DIR。 */
  runDir: string | null;
  nodeId: string;
  /** 只有数据库确认仍在运行的当前轮会话可按活跃 writer 读取。 */
  activeSessionId: string | null;
  /** 仅供单测把安全根指到临时目录。 */
  runsRoot?: string;
}

interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: number;
  delegationDepth: number;
  cwd?: string;
}

interface ParsedSessionLog {
  header: SessionHeader;
  events: SessionEvent[];
}

interface ToolCallFact {
  seq: number;
  time: number;
  turn: number;
  step: number;
  callId: string;
  name: string;
  arguments: string;
}

interface ToolResultFact {
  seq: number;
  time: number;
  turn: number;
  step: number;
  callId: string;
  content: string;
  isError: boolean;
  error?: unknown;
  meta?: unknown;
  attachments: Record<string, unknown>[];
}

type AssistantProjectionBlock =
  | { type: "text" | "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "image"; attachment: unknown };

interface AssistantStepFact {
  turn: number;
  step: number;
  startSeq: number;
  lastSeq: number;
  startTime: number;
  blocks: Array<AssistantProjectionBlock | undefined>;
  firstTokenTime: number | null;
  usage?: TrajectoryUsage;
  retry?: Extract<SessionEvent, { type: "llm/retry" }>;
  final?: Extract<SessionEvent, { type: "assistant/message" }>;
  stepEnd?: Extract<SessionEvent, { type: "step/end" }>;
}

const MAX_DETAIL_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 180;
const MAX_SESSION_LOG_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_FILES = 128;

const PROJECTED_EVENT_TYPES = new Set<string>([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
  "request/header",
  "request/context",
  "llm/retry",
]);

/** rc.2 已知但本精简视图不展示的 durable 事实；新增 required 类型必须显式审阅。 */
const IGNORED_EVENT_TYPES = new Set<string>([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "sandbox/mode",
  "schedule/change",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "subagent/descriptor",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "web/deepseek-search-llm-request",
]);

/** 读取一个运行里属于某 Action 的全部轮次，并按轮次返回精简展示投影。 */
export function readAgentTrajectory(
  options: ReadAgentTrajectoryOptions,
): AgentTrajectoryResponse {
  if (options.runDir === null) {
    return { available: false, reason: "not-recorded", sessions: [] };
  }

  // runDir / runsRoot 是数据库事实与单测注入值，不是构建输入；两者仍会在下方
  // 收敛到 data/runs 并做 realpath 校验，禁止 Turbopack 因动态值追踪整个仓库。
  const runsRoot = path.resolve(
    /* turbopackIgnore: true */ options.runsRoot ?? path.join(DATA_DIR, "runs"),
  );
  const storedCandidate = path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    options.runDir,
  );
  const candidate =
    options.runsRoot === undefined
      ? resolveWithinData(path.relative(DATA_DIR, storedCandidate))
      : storedCandidate;
  assertDescendant(runsRoot, candidate, "运行目录越界 data/runs");
  if (!fs.existsSync(candidate)) {
    return { available: false, reason: "cleaned", sessions: [] };
  }

  const rootReal = realDirectory(runsRoot, "运行数据目录不可读");
  const runReal = realDirectory(candidate, "运行目录不可读");
  // lexical 校验之外再校验 realpath，拒绝 data/runs 内指向外部的符号链接。
  assertDescendant(rootReal, runReal, "运行目录越界 data/runs");

  const sessionsRoot = path.join(runReal, "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    return { available: false, reason: "not-recorded", sessions: [] };
  }
  const sessionsReal = realDirectory(sessionsRoot, "会话目录不可读");
  assertDescendant(runReal, sessionsReal, "会话目录越界运行目录");

  const projected: TrajectorySession[] = [];
  let visited = 0;
  const encodedNodeId = encodeSessionSegment(options.nodeId);
  for (const cwdEntry of readDirectories(sessionsReal)) {
    const cwdBucket = path.join(
      /* turbopackIgnore: true */ sessionsReal,
      cwdEntry.name,
    );
    for (const sessionEntry of readDirectories(cwdBucket)) {
      // rc.2 的 session 目录名是 encodeSegment(id)。先用这个可逆编码筛候选，
      // 避免打开一个节点时全文读取同一运行内其它 Agent 的大日志；header 仍是
      // 归属权威，目录名只负责缩小 I/O 范围。
      if (!isCandidateSessionDirectory(sessionEntry.name, encodedNodeId)) continue;
      if (++visited > MAX_SESSION_FILES) {
        throw new Error(`单次运行的会话文件超过上限 ${MAX_SESSION_FILES}`);
      }
      const logPath = path.join(
        /* turbopackIgnore: true */ cwdBucket,
        sessionEntry.name,
        "session.jsonl",
      );
      const content = readLogFile(logPath, runReal);
      if (content === undefined) continue;
      const header = parseHeader(content);
      if (header === undefined) continue;
      const round = roundOf(header.id, options.nodeId);
      if (round === null) continue;
      const active = header.id === options.activeSessionId;
      const parsed = parseSessionJsonl(content);
      projected.push(projectSession(parsed, round, runReal, active));
    }
  }

  projected.sort(
    (left, right) =>
      left.round - right.round ||
      left.startedAt - right.startedAt ||
      left.id.localeCompare(right.id),
  );
  if (projected.length === 0) {
    return { available: false, reason: "not-recorded", sessions: [] };
  }
  return { available: true, sessions: projected };
}

function readDirectories(directory: string): fs.Dirent[] {
  try {
    // 符号链接不算目录，避免会话树借链接逃出运行目录。
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    throw new Error("会话目录不可读");
  }
}

function readLogFile(logPath: string, runReal: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(logPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error("会话日志不可读");
  }
  if (!stat.isFile()) return undefined;
  let logReal: string;
  try {
    logReal = fs.realpathSync.native(logPath);
  } catch {
    throw new Error("会话日志不可读");
  }
  assertDescendant(runReal, logReal, "会话日志越界运行目录");
  // 与上游 JSONL 读取边界一致：只有 stat-read-stat 得到同一份快照才交给
  // 解析器。活跃 writer 若恰好撞上读取，短促重试而不混合两个写入时刻。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const before = fs.statSync(logReal);
      if (before.size > MAX_SESSION_LOG_BYTES) {
        throw new Error(`单个会话日志超过上限 ${MAX_SESSION_LOG_BYTES} 字节`);
      }
      const content = fs.readFileSync(logReal, "utf8");
      const after = fs.statSync(logReal);
      if (
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs
      ) {
        return content;
      }
    } catch (error) {
      // 活跃运行在枚举后、读取前完成清理时，把它当作本轮未观察到。
      if (hasCode(error, "ENOENT")) return undefined;
      if (error instanceof Error && error.message.includes("超过上限")) throw error;
      throw new Error("会话日志不可读");
    }
  }
  throw new Error("会话日志正在变化，请稍后重试");
}

function parseHeader(content: string): SessionHeader | undefined {
  const end = content.indexOf("\n");
  // 上游把换行视为 JSONL record 的提交边界；只有 header 正文而无换行时，
  // 整个文件仍是 torn tail，不能据此构造一个空会话。
  if (end === -1) return undefined;
  const line = content.slice(0, end);
  if (line.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) return undefined;
    if (
      value.type !== "session" ||
      !Number.isSafeInteger(value.version) ||
      typeof value.id !== "string" ||
      !isNonNegativeSafeInteger(value.createdAt) ||
      !isNonNegativeSafeInteger(value.delegationDepth)
    ) {
      return undefined;
    }
    return {
      type: "session",
      version: value.version as number,
      id: value.id,
      createdAt: value.createdAt,
      delegationDepth: value.delegationDepth,
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * 逐 physical line 解码。packed chunk row 必须经过 DSH 自己的 codec；无论 cold/live，
 * 最后一个未换行的物理行都尚未提交并忽略，其它坏行一律视为损坏。
 */
export function parseSessionJsonl(content: string): ParsedSessionLog {
  const header = parseHeader(content);
  if (header === undefined) throw new Error("会话日志缺少合法 header");
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `会话日志版本不受支持：需要 ${SESSION_FORMAT_VERSION}，实际 ${header.version}`,
    );
  }

  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const events: SessionEvent[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const isSplitSentinel = index === lines.length - 1 && hasTrailingNewline && line === "";
    if (isSplitSentinel) continue;
    const isUncommittedTail = index === lines.length - 1 && !hasTrailingNewline;
    // 无换行即未提交：cold/live 都不能把 writer 尚未提交的最后一行误认为
    // durable event。终态缺失的收束事件由下游 interrupted repair 表达。
    if (isUncommittedTail) break;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`会话日志损坏：第 ${index + 1} 行不是合法 JSON`);
    }

    let decoded: SessionEvent[];
    try {
      decoded = decodeStorageRecord(value);
    } catch {
      throw new Error(`会话日志损坏：第 ${index + 1} 行的 packed record 无效`);
    }
    for (const event of decoded) {
      if (!isEventEnvelope(event)) {
        throw new Error(`会话日志损坏：第 ${index + 1} 行不是合法事件`);
      }
      assertKnownProjectionEvent(event, index + 1);
      events.push(event);
    }
  }
  let expectedSeq = 0;
  for (const event of events) {
    if (event.seq !== expectedSeq) {
      throw new Error(
        `会话日志损坏：事件 seq 不连续，需要 ${expectedSeq}，实际 ${event.seq}`,
      );
    }
    expectedSeq++;
  }
  return { header, events };
}

/** 把一份完整 durable log 投影成一个轮次的三轨迹展示数据。 */
export function projectSession(
  parsed: ParsedSessionLog,
  round: number,
  runDirectory = "",
  active = false,
): TrajectorySession {
  const { header, events } = parsed;
  const scrubRoots = [header.cwd, runDirectory].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const records: TrajectoryRecord[] = [];
  const toolCalls = new Map<string, ToolCallFact>();
  const toolResults = new Map<string, ToolResultFact>();
  const turnNumbers = new Set<number>();
  const stepNumbers = new Set<string>();
  const assistantSteps = new Map<string, AssistantStepFact>();
  const turnEnds = new Map<
    number,
    Extract<SessionEvent, { type: "turn/end" }>
  >();

  let currentTurn: number | null = null;
  let currentStep: number | null = null;
  let provider = "";
  let model = "";
  let contextWindow: number | null = null;
  let status: TrajectorySessionStatus = "unknown";
  let finishedAt: number | null = null;

  for (const event of events) {
    switch (event.type) {
      case "turn/start": {
        currentTurn = event.data.turn;
        currentStep = null;
        turnNumbers.add(event.data.turn);
        // 一个已完成回合后可以继续下一回合；新 turn 会重新打开会话。
        status = "running";
        finishedAt = null;
        break;
      }
      case "step/start": {
        currentTurn = event.data.turn;
        currentStep = event.data.step;
        turnNumbers.add(event.data.turn);
        const key = stepKey(event.data.turn, event.data.step);
        stepNumbers.add(key);
        assistantSteps.set(key, newAssistantStep(event));
        status = "running";
        break;
      }
      case "assistant/chunk": {
        const key = stepKey(event.data.turn, event.data.step);
        turnNumbers.add(event.data.turn);
        stepNumbers.add(key);
        const state = assistantSteps.get(key) ?? fallbackAssistantStep(event);
        assistantSteps.set(key, applyAssistantChunk(state, event));
        break;
      }
      case "request/header": {
        const config = event.data.header.config;
        if (typeof config.provider === "string") provider = config.provider;
        if (typeof config.model === "string") model = config.model;
        const tools = event.data.header.tools ?? [];
        const details: TrajectoryDetail[] = [];
        if (typeof event.data.header.system === "string") {
          details.push(
            detail("系统提示", event.data.header.system, "text", scrubRoots),
          );
        }
        if (tools.length > 0) {
          details.push(detail("工具清单", tools, "json", scrubRoots));
        }
        const initial = event.data.reason === "initial";
        records.push({
          id: `${header.id}:system:${event.seq}`,
          seq: event.seq,
          kind: "system",
          lane: "input",
          label: initial ? "初始系统提示" : "系统提示已更新",
          summary: summary(
            `${event.data.header.system ? "系统提示" : "无系统提示"}${tools.length > 0 ? ` · ${tools.length} 个工具` : ""}`,
            scrubRoots,
          ),
          turn: currentTurn,
          step: currentStep,
          startedAt: event.time,
          finishedAt: event.time,
          state: "complete",
          details,
        });
        break;
      }
      case "request/context": {
        provider = event.data.provider;
        model = event.data.model;
        contextWindow = event.data.contextWindow ?? null;
        records.push({
          id: `${header.id}:context:${event.seq}`,
          seq: event.seq,
          kind: "context",
          lane: "input",
          label: "模型上下文",
          summary: summary(
            `${provider}/${model}${contextWindow === null ? "" : ` · ${contextWindow.toLocaleString()} tokens`}`,
            scrubRoots,
          ),
          turn: currentTurn,
          step: currentStep,
          startedAt: event.time,
          finishedAt: event.time,
          state: "complete",
          details: [
            detail(
              "请求上下文",
              {
                provider,
                model,
                ...(contextWindow === null ? {} : { contextWindow }),
              },
              "json",
              scrubRoots,
            ),
          ],
        });
        break;
      }
      case "user/message": {
        const source = event.data.source;
        const sourceKind = sourceKindOf(source);
        const direct = sourceKind === "user";
        const content = blocksText(event.data.content);
        records.push({
          id: `${header.id}:${direct ? "user" : "context"}:${event.seq}`,
          seq: event.seq,
          kind: direct ? "user" : "context",
          lane: "input",
          label: direct ? "用户" : contextLabel(sourceKind, source),
          summary: summary(
            content || (direct ? "用户输入" : "上下文注入"),
            scrubRoots,
          ),
          turn: currentTurn,
          step: currentStep,
          startedAt: event.time,
          finishedAt: event.time,
          state: "complete",
          details: [detail(direct ? "输入" : "上下文", content, "text", scrubRoots)],
        });
        break;
      }
      case "assistant/message": {
        const key = stepKey(event.data.turn, event.data.step);
        turnNumbers.add(event.data.turn);
        stepNumbers.add(key);
        const state = assistantSteps.get(key) ?? fallbackAssistantStep(event);
        assistantSteps.set(key, { ...state, final: event });
        provider ||= event.data.message.source.provider;
        model ||= event.data.message.source.model;
        break;
      }
      case "llm/retry": {
        const key = stepKey(event.data.turn, event.data.step);
        turnNumbers.add(event.data.turn);
        stepNumbers.add(key);
        const state = assistantSteps.get(key) ?? fallbackAssistantStep(event);
        // 新 attempt 不继承上一次未落成 assistant/message 的可见块；首 token
        // 与已产生的 usage 属于整次请求生命周期，按 rc.2 语义继续累计。
        assistantSteps.set(key, {
          ...state,
          lastSeq: event.seq,
          blocks: [],
          retry: event,
          final: undefined,
          stepEnd: undefined,
        });
        records.push(retryRecord(event, scrubRoots, header.id));
        break;
      }
      case "tool/call": {
        turnNumbers.add(event.data.turn);
        stepNumbers.add(stepKey(event.data.turn, event.data.step));
        if (!toolCalls.has(String(event.data.callId))) {
          toolCalls.set(String(event.data.callId), {
            seq: event.seq,
            time: event.time,
            turn: event.data.turn,
            step: event.data.step,
            callId: String(event.data.callId),
            name: event.data.name,
            arguments: event.data.arguments,
          });
        }
        break;
      }
      case "tool/result": {
        const result = toolResultFact(event);
        if (result !== null && !toolResults.has(result.callId)) {
          toolResults.set(result.callId, result);
        }
        break;
      }
      case "step/end": {
        const key = stepKey(event.data.turn, event.data.step);
        const state = assistantSteps.get(key) ?? fallbackAssistantStep(event);
        assistantSteps.set(key, { ...state, stepEnd: event });
        currentStep = null;
        break;
      }
      case "turn/end": {
        turnNumbers.add(event.data.turn);
        turnEnds.set(event.data.turn, event);
        status = statusOf(event.data.reason.kind);
        finishedAt = event.time;
        if (event.data.reason.kind !== "completed") {
          records.push(turnErrorRecord(event, scrubRoots, header.id));
        }
        currentTurn = null;
        currentStep = null;
        break;
      }
      default:
        break;
    }
  }

  const lastEventTime = events.at(-1)?.time ?? header.createdAt;
  if (!active && (status === "running" || (status === "unknown" && assistantSteps.size > 0))) {
    status = "interrupted";
    finishedAt = lastEventTime;
  } else if (active && status === "unknown" && assistantSteps.size > 0) {
    status = "running";
  }

  const latestInputSeq = new Map<string, number>();
  for (const record of records) {
    if (record.lane !== "input" || record.turn === null || record.step === null) continue;
    const key = stepKey(record.turn, record.step);
    latestInputSeq.set(key, Math.max(latestInputSeq.get(key) ?? -1, record.seq));
  }
  for (const original of assistantSteps.values()) {
    const state = {
      ...original,
      lastSeq: Math.max(
        original.lastSeq,
        latestInputSeq.get(stepKey(original.turn, original.step)) ?? -1,
      ),
    };
    const record = assistantRecord(
      state,
      turnEnds.get(state.turn),
      scrubRoots,
      header.id,
      active,
      lastEventTime,
    );
    records.push(record);
  }

  const callIds = new Set([...toolCalls.keys(), ...toolResults.keys()]);
  for (const callId of callIds) {
    const call = toolCalls.get(callId);
    const result = toolResults.get(callId);
    records.push(
      toolRecord(
        callId,
        call,
        result,
        scrubRoots,
        header.id,
        active,
        finishedAt ?? lastEventTime,
      ),
    );
  }

  records.sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  // 上游 Trajectory 把初始 SYSTEM 作为整段会话的前置上下文，而不是按实际
  // request/header 的落盘位置夹在 USER/CONTEXT 后面。
  const firstSystem = records.findIndex((record) => record.kind === "system");
  if (firstSystem > 0) {
    const [system] = records.splice(firstSystem, 1);
    if (system) records.unshift(system);
  }

  const durationMs = finishedAt === null ? null : Math.max(0, finishedAt - header.createdAt);
  return {
    id: header.id,
    round,
    status,
    startedAt: header.createdAt,
    finishedAt,
    durationMs,
    provider,
    model,
    contextWindow,
    turns: turnNumbers.size,
    steps: stepNumbers.size,
    calls: callIds.size,
    records,
  };
}

function newAssistantStep(
  event: Extract<SessionEvent, { type: "step/start" }>,
): AssistantStepFact {
  return {
    turn: event.data.turn,
    step: event.data.step,
    startSeq: event.seq,
    lastSeq: event.seq,
    startTime: event.time,
    blocks: [],
    firstTokenTime: null,
  };
}

function fallbackAssistantStep(event: {
  seq: number;
  time: number;
  data: { turn: number; step: number };
}): AssistantStepFact {
  return {
    turn: event.data.turn,
    step: event.data.step,
    startSeq: event.seq,
    lastSeq: event.seq,
    startTime: event.time,
    blocks: [],
    firstTokenTime: null,
  };
}

function applyAssistantChunk(
  state: AssistantStepFact,
  event: Extract<SessionEvent, { type: "assistant/chunk" }>,
): AssistantStepFact {
  const chunk = event.data.chunk;
  if (chunk.type === "usage") {
    return {
      ...state,
      lastSeq: event.seq,
      usage: addUsage(state.usage, normalizeUsage(chunk.usage)),
    };
  }

  const blocks = [...state.blocks];
  switch (chunk.type) {
    case "block-start":
      if (chunk.blockType === "text" || chunk.blockType === "reasoning") {
        blocks[chunk.index] = { type: chunk.blockType, text: "" };
      } else if (chunk.blockType === "tool-call") {
        blocks[chunk.index] = { type: "tool-call", id: "", name: "", arguments: "" };
      } else if (chunk.blockType === "image") {
        blocks[chunk.index] = { type: "image", attachment: null };
      }
      break;
    case "text-delta": {
      const previous = blocks[chunk.index];
      blocks[chunk.index] = {
        type: "text",
        text: (previous?.type === "text" ? previous.text : "") + chunk.text,
      };
      break;
    }
    case "reasoning-delta": {
      const previous = blocks[chunk.index];
      blocks[chunk.index] = {
        type: "reasoning",
        text: (previous?.type === "reasoning" ? previous.text : "") + chunk.text,
      };
      break;
    }
    case "tool-call-delta": {
      const previous = blocks[chunk.index];
      blocks[chunk.index] = {
        type: "tool-call",
        id: previous?.type === "tool-call" && previous.id ? previous.id : String(chunk.id),
        name: chunk.name ?? (previous?.type === "tool-call" ? previous.name : ""),
        arguments:
          (previous?.type === "tool-call" ? previous.arguments : "") +
          chunk.argumentsDelta,
      };
      break;
    }
    case "block-end": {
      const projected = projectAssistantBlock(chunk.block);
      if (projected !== null) blocks[chunk.index] = projected;
      break;
    }
    default:
      break;
  }
  return {
    ...state,
    lastSeq: event.seq,
    blocks,
    firstTokenTime:
      state.firstTokenTime ?? (isVisibleChunk(chunk) ? event.time : null),
  };
}

function projectAssistantBlock(value: unknown): AssistantProjectionBlock | null {
  if (!isContentBlock(value)) return null;
  if (
    (value.type === "text" || value.type === "reasoning") &&
    typeof value.text === "string"
  ) {
    return { type: value.type, text: value.text };
  }
  if (value.type === "tool-call") {
    return {
      type: "tool-call",
      id: typeof value.id === "string" ? value.id : "",
      name: typeof value.name === "string" ? value.name : "",
      arguments: typeof value.arguments === "string" ? value.arguments : "",
    };
  }
  if (value.type === "image") return { type: "image", attachment: value.attachment };
  return null;
}

function assistantRecord(
  state: AssistantStepFact,
  turnEnd: Extract<SessionEvent, { type: "turn/end" }> | undefined,
  scrubRoots: string[],
  sessionId: string,
  sessionActive: boolean,
  lastEventTime: number,
): TrajectoryRecord {
  const final = state.final;
  const boundary = state.stepEnd ?? turnEnd;

  const blocks: readonly unknown[] =
    final?.data.message.content ?? state.blocks.filter(isDefined);
  const reasoning = blocksText(blocks, "reasoning");
  const text = blocksText(blocks, "text");
  const toolCount = blocks.filter(
    (block) => isContentBlock(block) && block.type === "tool-call",
  ).length;
  // 每个 attempt 的 usage chunk 都是独立结算值：跨 retry 求和；最终
  // assistant/message 携带的是同一结算的副本，只在完全没有 chunk usage 时兜底。
  const usage = state.usage ??
    (final?.data.usage === undefined ? undefined : normalizeUsage(final.data.usage));
  const interrupted =
    final?.data.interrupted === true ||
    (final === undefined && (boundary !== undefined || !sessionActive));
  const running = final === undefined && !interrupted;
  const completedAt = final?.time ?? boundary?.time ?? (interrupted ? lastEventTime : null);
  const details: TrajectoryDetail[] = [];
  if (reasoning) details.push(detail("推理", reasoning, "text", scrubRoots));
  if (text) details.push(detail("回答", text, "text", scrubRoots));
  if (usage) details.push(detail("用量", usage, "json", scrubRoots));
  if (state.retry !== undefined) {
    details.push(detail("最近重试", retryDetail(state.retry), "json", scrubRoots));
  }
  details.push(
    detail(
      "时序",
      {
        stepStartedAt: state.startTime,
        firstTokenAt: state.firstTokenTime,
        completedAt,
        ttftMs:
          state.firstTokenTime === null
            ? null
            : Math.max(0, state.firstTokenTime - state.startTime),
        durationMs:
          completedAt === null ? null : Math.max(0, completedAt - state.startTime),
      },
      "json",
      scrubRoots,
    ),
  );
  const assistantSummary =
    text ||
    reasoning ||
    (toolCount > 0
      ? `请求调用 ${toolCount} 个工具`
      : running
        ? "模型正在响应"
        : interrupted
          ? "模型响应未完成"
          : "模型响应");
  return {
    id: `${sessionId}:assistant:${state.turn}:${state.step}`,
    seq: final?.seq ?? state.lastSeq,
    kind: "assistant",
    lane: "model",
    label: running ? "模型响应中" : interrupted ? "模型响应中断" : "模型响应",
    summary: summary(assistantSummary, scrubRoots),
    turn: state.turn,
    step: state.step,
    startedAt: state.startTime,
    finishedAt: completedAt,
    state: running ? "running" : interrupted ? "error" : "complete",
    details,
    ...(usage === undefined ? {} : { usage }),
  };
}

function retryRecord(
  event: Extract<SessionEvent, { type: "llm/retry" }>,
  scrubRoots: string[],
  sessionId: string,
): TrajectoryRecord {
  return {
    id: `${sessionId}:retry:${event.seq}`,
    seq: event.seq,
    kind: "error",
    lane: "model",
    label: `模型请求重试 #${event.data.retry}`,
    summary: summary(event.data.failure.message, scrubRoots),
    turn: event.data.turn,
    step: event.data.step,
    startedAt: event.time,
    finishedAt: event.time,
    state: "error",
    details: [detail("重试事实", retryDetail(event), "json", scrubRoots)],
  };
}

function retryDetail(event: Extract<SessionEvent, { type: "llm/retry" }>) {
  return {
    provider: event.data.provider,
    mode: event.data.mode,
    policyKey: event.data.policyKey,
    retry: event.data.retry,
    ...(event.data.mode === "normal" ? { maxRetries: event.data.maxRetries } : {}),
    delayMs: event.data.delayMs,
    failure: event.data.failure,
  };
}

function addUsage(
  current: TrajectoryUsage | undefined,
  next: TrajectoryUsage,
): TrajectoryUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    reasoningTokens: (current?.reasoningTokens ?? 0) + next.reasoningTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function toolRecord(
  callId: string,
  call: ToolCallFact | undefined,
  result: ToolResultFact | undefined,
  scrubRoots: string[],
  sessionId: string,
  sessionActive: boolean,
  lastEventTime: number,
): TrajectoryRecord {
  const toolName = call?.name ?? "未知工具";
  const isError = result?.isError === true;
  const interrupted = result === undefined && !sessionActive;
  const state: TrajectoryRecord["state"] =
    result === undefined
      ? interrupted
        ? "error"
        : "running"
      : isError
        ? "error"
        : "complete";
  const details: TrajectoryDetail[] = [];
  if (call !== undefined) {
    const parsed = parseJson(call.arguments);
    details.push(
      detail("参数", parsed.value, parsed.format, scrubRoots),
    );
  }
  if (result !== undefined) {
    details.push(detail("结果", result.content, "text", scrubRoots));
    if (result.attachments.length > 0) {
      details.push(detail("结果附件", result.attachments, "json", scrubRoots));
    }
    if (result.error !== undefined) {
      details.push(detail("错误", result.error, "json", scrubRoots));
    }
    if (result.meta !== undefined) {
      details.push(detail("展示元数据", result.meta, "json", scrubRoots));
    }
  } else if (interrupted) {
    details.push(
      detail("状态", "会话已结束，但没有记录到对应的工具结果。", "text", scrubRoots),
    );
  }
  const anchor = call ?? result;
  if (anchor === undefined) throw new Error("工具轨迹缺少调用与结果");
  const startedAt = call?.time ?? result?.time ?? anchor.time;
  const finishedAt = result === undefined
    ? interrupted
      ? Math.max(startedAt, lastEventTime)
      : null
    : Math.max(startedAt, result.time);
  return {
    id: `${sessionId}:tool:${callId}`,
    seq: call?.seq ?? result?.seq ?? anchor.seq,
    kind: "tool",
    lane: "tools",
    label: toolName,
    summary: summary(
      `${toolName} · ${state === "running" ? "运行中" : interrupted ? "已中断" : state === "error" ? "失败" : "完成"}`,
      scrubRoots,
    ),
    turn: call?.turn ?? result?.turn ?? null,
    step: call?.step ?? result?.step ?? null,
    startedAt,
    finishedAt,
    state,
    callId,
    toolName,
    details,
  };
}

function toolResultFact(
  event: Extract<SessionEvent, { type: "tool/result" }>,
): ToolResultFact | null {
  const message = event.data.message;
  const block = message.content.find((candidate) => candidate.type === "tool-result");
  const callId =
    message.source.kind === "tool"
      ? String(message.source.callId)
      : block?.type === "tool-result"
        ? String(block.toolCallId)
        : "";
  if (!callId) return null;
  const content = block?.type === "tool-result" ? blocksText(block.content) : "";
  const attachments =
    block?.type === "tool-result" ? safeImageAttachments(block.content) : [];
  return {
    seq: event.seq,
    time: event.time,
    turn: event.data.turn,
    step: event.data.step,
    callId,
    content,
    attachments,
    isError: event.data.error !== undefined || block?.isError === true,
    ...(event.data.error === undefined ? {} : { error: event.data.error }),
    ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
  };
}

function safeImageAttachments(blocks: readonly unknown[]): Record<string, unknown>[] {
  const attachments: Record<string, unknown>[] = [];
  for (const candidate of blocks) {
    if (!isContentBlock(candidate) || candidate.type !== "image") continue;
    const attachment = candidate.attachment;
    if (!isRecord(attachment)) continue;
    const safe: Record<string, unknown> = {};
    if (typeof attachment.attachmentId === "string") {
      safe.attachmentId = attachment.attachmentId;
    }
    if (typeof attachment.mediaType === "string") safe.mediaType = attachment.mediaType;
    for (const field of ["bytes", "width", "height"] as const) {
      if (isNonNegativeSafeInteger(attachment[field])) safe[field] = attachment[field];
    }
    if (typeof attachment.name === "string") safe.name = path.basename(attachment.name);
    if (isRecord(attachment.originalDimensions)) {
      const width = attachment.originalDimensions.width;
      const height = attachment.originalDimensions.height;
      if (isNonNegativeSafeInteger(width) && isNonNegativeSafeInteger(height)) {
        safe.originalDimensions = { width, height };
      }
    }
    attachments.push(safe);
  }
  return attachments;
}

function turnErrorRecord(
  event: Extract<SessionEvent, { type: "turn/end" }>,
  scrubRoots: string[],
  sessionId: string,
): TrajectoryRecord {
  const reason = event.data.reason;
  const labels: Partial<Record<string, string>> = {
    error: "回合失败",
    aborted: "回合已取消",
    blocked: "回合被阻止",
    "max-tokens": "达到输出上限",
    interrupted: "回合意外中断",
  };
  const message =
    reason.kind === "error" ? reason.error.message : labels[reason.kind] ?? reason.kind;
  return {
    id: `${sessionId}:error:${event.seq}`,
    seq: event.seq,
    kind: "error",
    lane: "model",
    label: labels[reason.kind] ?? "回合未完成",
    summary: summary(message, scrubRoots),
    turn: event.data.turn,
    step: null,
    startedAt: event.time,
    finishedAt: event.time,
    state: "error",
    details: [detail("结束原因", reason, "json", scrubRoots)],
  };
}

function statusOf(kind: string): TrajectorySessionStatus {
  switch (kind) {
    case "completed":
    case "error":
    case "aborted":
    case "blocked":
    case "max-tokens":
    case "interrupted":
      return kind;
    default:
      return "unknown";
  }
}

function normalizeUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): TrajectoryUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  };
}

function isVisibleChunk(
  chunk: Extract<SessionEvent, { type: "assistant/chunk" }>['data']['chunk'],
): boolean {
  switch (chunk.type) {
    case "text-delta":
      return chunk.text.length > 0;
    case "reasoning-delta":
      return chunk.text.length > 0;
    case "tool-call-delta":
      return chunk.argumentsDelta.length > 0 || (chunk.name?.length ?? 0) > 0;
    default:
      return false;
  }
}

function blocksText(
  blocks: readonly unknown[],
  only?: "text" | "reasoning",
): string {
  const parts: string[] = [];
  for (const candidate of blocks) {
    if (!isContentBlock(candidate)) continue;
    const block = candidate;
    if (only !== undefined && block.type !== only) continue;
    if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (only !== undefined) continue;
    if (block.type === "image") {
      parts.push("[图片]");
      continue;
    }
    if (block.type === "tool-call") {
      const name = typeof block.name === "string" ? block.name : "未知工具";
      parts.push(`[调用工具 ${name}]`);
      continue;
    }
    if (block.type === "tool-result" && Array.isArray(block.content)) {
      const nested = block.content.filter(isContentBlock);
      parts.push(blocksText(nested));
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

function isContentBlock(value: unknown): value is { type: string; [key: string]: unknown } {
  return isRecord(value) && typeof value.type === "string";
}

function contextLabel(sourceKind: string, source: unknown): string {
  if (sourceKind === "agent-instructions") return "工作区指令";
  if (sourceKind === "skill") return "Skill 上下文";
  if (sourceKind === "plugin" && isRecord(source) && typeof source.plugin === "string") {
    return `上下文 · ${source.plugin}`;
  }
  return `上下文 · ${sourceKind || "未知来源"}`;
}

function sourceKindOf(source: unknown): string {
  return isRecord(source) && typeof source.kind === "string" ? source.kind : "unknown";
}

function detail(
  label: string,
  value: unknown,
  format: "text" | "json",
  scrubRoots: string[],
): TrajectoryDetail {
  const raw = format === "json" ? stringify(value) : String(value ?? "");
  const scrubbed = scrubPhysicalPaths(raw, scrubRoots);
  const clipped = bound(scrubbed, MAX_DETAIL_CHARS);
  return { label, content: clipped.content, format, truncated: clipped.truncated };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseJson(raw: string): { value: unknown; format: "text" | "json" } {
  try {
    return { value: JSON.parse(raw) as unknown, format: "json" };
  } catch {
    return { value: raw, format: "text" };
  }
}

function summary(value: string, scrubRoots: string[]): string {
  return bound(
    scrubPhysicalPaths(value, scrubRoots).replace(/\s+/g, " ").trim(),
    MAX_SUMMARY_CHARS,
  ).content;
}

function bound(value: string, max: number): { content: string; truncated: boolean } {
  if (value.length <= max) return { content: value, truncated: false };
  return { content: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

function scrubPhysicalPaths(value: string, roots: string[]): string {
  let scrubbed = value;
  for (const [index, root] of roots.entries()) {
    const normalized = path.resolve(root);
    scrubbed = scrubbed.split(normalized).join(index === 0 ? "<workspace>" : "<run>");
  }
  // 兜住工具或插件返回的其它本机绝对路径；相对产物路径不受影响。
  scrubbed = scrubbed.replace(
    /(?:\/Users|\/home|\/private\/var|\/var\/folders|\/tmp)\/[\w@%+.,~()\[\]{}=\-\/\\]+/g,
    "<本地路径>",
  );
  scrubbed = scrubbed.replace(/[A-Za-z]:\\[^\s<>"']+/g, "<本地路径>");
  return scrubbed;
}

/**
 * rc.2 session-persistence-jsonl 的 encodeSegment 规则。必须逐 UTF-16 code unit
 * 编码，不能用 encodeURIComponent：后者既不处理 lone surrogate，也不生成实际
 * session 目录使用的 `~XXXX` 名称。
 */
export function encodeSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error("会话 id 不能为空");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded +=
      character !== "~" && /^[A-Za-z0-9._-]$/.test(character)
        ? character
        : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

function isCandidateSessionDirectory(name: string, encodedNodeId: string): boolean {
  if (name === encodedNodeId) return true;
  const roundPrefix = `${encodedNodeId}~0023`;
  if (!name.startsWith(roundPrefix)) return false;
  return /^[1-9]\d*$/.test(name.slice(roundPrefix.length));
}

function roundOf(sessionId: string, nodeId: string): number | null {
  if (sessionId === nodeId) return 1;
  const prefix = `${nodeId}#`;
  if (!sessionId.startsWith(prefix)) return null;
  const suffix = sessionId.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix)) return null;
  const round = Number(suffix);
  return Number.isSafeInteger(round) ? round : null;
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`;
}

function assertDescendant(root: string, target: string, message: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function realDirectory(directory: string, message: string): string {
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) throw new Error(message);
    return fs.realpathSync.native(directory);
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    throw new Error(message);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

function isEventEnvelope(value: unknown): value is SessionEvent {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    Number.isSafeInteger(value.seq) &&
    isFiniteNumber(value.time) &&
    Object.hasOwn(value, "data")
  );
}

function assertKnownProjectionEvent(event: SessionEvent, line: number): void {
  if (PROJECTED_EVENT_TYPES.has(event.type) || IGNORED_EVENT_TYPES.has(event.type)) return;
  if (event.ignorable === true) return;
  throw new Error(
    `会话日志包含未知 required event：第 ${line} 行 ${JSON.stringify(event.type)}`,
  );
}
