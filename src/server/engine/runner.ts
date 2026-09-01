/**
 * 运行编排：startRun（校验 + 建 run + 异步执行）与 executeRun（就绪驱动并行）。
 *
 * 一次运行 = 一个独立工作区 + 一个 harness 子进程（ADR-0007）。executeRun 建工作区、
 * 物化全部运行输入、起子进程，然后按拓扑序驱动节点，最后无论成败都把子进程收束到静止。
 *
 * - 输入节点 → outputs = { value: 用户输入 }；输出节点 → 上游值透传为 outputs；
 *   Action 节点 → runActionNode（在子进程里开一个会话）。
 * - 节点失败 → run_nodes.error + 下游全部 skipped + run failed；全部成功 → run success。
 * - cancelRun 是人为中止：取消在跑会话 + 节点 cancelled + 下游 skipped + run cancelled，
 *   是区别于 failed 的独立终态（run.error 留空）。
 * - 任何异常都落到 run / run_nodes.error，绝不留 running 悬挂。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import {
  classifyEdges,
  downstreamOf,
  validateGraph,
  type ResolvedNode,
  type ValidationIssue,
} from "@/lib/graph";
import { MAX_FILE_INPUT_BYTES, type PortValue } from "@/lib/values";
import { DATA_DIR, isWithinData, resolveWithinData, safeBasename } from "@/server/fs-safety";
import { assertSafeId } from "@/server/harness/ids";
import {
  launchRun,
  UnsettledRunLaunchError,
} from "@/server/harness/launch";
import type { RunProcess } from "@/server/harness/runtime";
import {
  createRunWorkspace,
  WORKSPACE_INPUTS_SUBDIR,
  type RunWorkspace,
} from "@/server/harness/workspace";
import { resolveWorkflow, type ResolvedWorkflow } from "@/server/resolve";
import { readSettings, type SettingsDocument } from "@/server/settings";
import {
  finalizeUnsettledActionUsage,
  refreshUnsettledActionUsage,
  runActionNode,
} from "./action";
import {
  collectCapabilities,
  materializeToolPlugins,
  toolFilterForAction,
} from "./capabilities";
import { recordSessionEvent, type EventSinkContext } from "./events";

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: 404 | 429; error: string }
  | { ok: false; status: 422; error: string; issues: ValidationIssue[] };

export type CancelRunResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string };

/** 运行由哪个受理边界发起；专用入口只读取自己留下的持久来源证明。 */
export type RunInvocationProvenance =
  | { source: "workflow" }
  | {
      source: "resume-match-api";
      contractVersion: 1;
      resultNodes: { outputNodeId: string; validatorNodeId: string };
    };

export type RunCompletionGate = (
  runId: string,
) =>
  | { ok: true; evidence: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * 进程级取消标记。executeRun 在每个节点开始前查它，已取消则停止调度剩余节点
 * （挂 globalThis 以免 HMR 重建模块时丢失正在跑的运行的标记）。
 */
interface RunnerGlobals {
  ontoflowCancelledRuns?: Set<string>;
  ontoflowRunProcesses?: Map<string, RunProcess>;
  ontoflowActiveRuns?: Set<string>;
  ontoflowRunDisposalFailures?: Set<string>;
  ontoflowPendingUsageSettlements?: Map<string, Promise<void>>;
}
const g = globalThis as RunnerGlobals;
const cancelledRuns: Set<string> = g.ontoflowCancelledRuns ?? new Set();
g.ontoflowCancelledRuns = cancelledRuns;
/** 在跑运行的子进程句柄；cancelRun 要拿它去取消会话（挂 globalThis 以免 HMR 丢失）。 */
const runProcesses: Map<string, RunProcess> = g.ontoflowRunProcesses ?? new Map();
g.ontoflowRunProcesses = runProcesses;
/**
 * 从 executeRun 接管到其全部 finally/终态写入收束为止的运行。它比 runs.status
 * 更精确：cancelRun 会先把状态写成 cancelled，此时子进程和工作区仍可能在收尾。
 * 清理模块据此拒绝删除仍被执行器持有的目录或数据库记录。
 */
const activeRuns: Set<string> = g.ontoflowActiveRuns ?? new Set();
g.ontoflowActiveRuns = activeRuns;
/**
 * dispose 报错意味着无法证明子进程已退出；这类运行继续留在 activeRuns，文件预览、
 * 清理和新运行准入全部 fail-closed，直到 Next 进程重启收走其子进程树。
 */
const disposalFailures: Set<string> = g.ontoflowRunDisposalFailures ?? new Set();
g.ontoflowRunDisposalFailures = disposalFailures;
/**
 * 子进程已退出但最终用量尚未完整落库的运行。任务会持续重试；Map 与 activeRuns
 * 一起挂在 globalThis，HMR 不能让清理路径失去这份隔离所有权。
 */
const pendingUsageSettlements: Map<string, Promise<void>> =
  g.ontoflowPendingUsageSettlements ?? new Map();
g.ontoflowPendingUsageSettlements = pendingUsageSettlements;

function waitForUsageSettlementRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(100 * 2 ** Math.min(attempt, 6), 5_000);
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    // 结算重试不能独自阻止 Next 进程正常退出；进程重启时由启动对账接管终态。
    timer.unref();
  });
}

/** 子进程退出后没有事件源可再触发刷新，因此由执行器持续持有并定时重试。 */
function scheduleUsageSettlementRetry(runId: string): Promise<void> {
  const existing = pendingUsageSettlements.get(runId);
  if (existing) return existing;
  const task = (async () => {
    let attempt = 0;
    for (;;) {
      await waitForUsageSettlementRetry(attempt);
      try {
        finalizeUnsettledActionUsage(runId);
        return;
      } catch (error) {
        attempt += 1;
        // 首次与随后每分钟左右留一条诊断，避免持久故障以 5 秒频率刷爆 stderr。
        if (attempt === 1 || attempt % 12 === 0) {
          console.error("[engine] 退出后的用量结算仍未完成，继续重试", runId, error);
        }
      }
    }
  })();
  pendingUsageSettlements.set(runId, task);
  return task;
}

/** 留出文件系统实现差异余量，避免贴着常见的 255-byte 单组件上限写入。 */
const INPUT_FILENAME_MAX_BYTES = 240;

/**
 * 保留可辨认前缀与短扩展名，超长部分用内容散列稳定收敛；NUL 在进入文件系统
 * 前替换，长度按 UTF-8 字节而非 JS 字符数计，非法名称不会在运行受理后异步失败。
 */
function boundedInputFilename(candidate: string): string {
  const basename = safeBasename(candidate.replaceAll("\0", "_"));
  if (Buffer.byteLength(basename, "utf8") <= INPUT_FILENAME_MAX_BYTES) return basename;

  const candidateExtension = path.extname(basename);
  const extension =
    Buffer.byteLength(candidateExtension, "utf8") <= 16 ? candidateExtension : "";
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  const suffix = `-${createHash("sha256").update(basename).digest("hex").slice(0, 12)}${extension}`;
  const prefixBudget = INPUT_FILENAME_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  let used = 0;
  for (const character of stem) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > prefixBudget) break;
    prefix += character;
    used += bytes;
  }
  return `${prefix || "input"}${suffix}`;
}

export function isRunCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}

export function isRunExecutionActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/** 清理与准入只读快照；不把可变 Set 暴露到执行器之外。 */
export function activeRunExecutionIds(): string[] {
  return [...activeRuns];
}

/** PortValue 形态校验（前端传入的运行输入不可信） */
function isPortValue(value: unknown): value is PortValue {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "text") return typeof v.text === "string";
  if (v.kind === "json") return "json" in v;
  if (v.kind === "file") {
    const file = v.file as Record<string, unknown> | undefined;
    return (
      !!file &&
      typeof file.path === "string" &&
      typeof file.name === "string" &&
      typeof file.mime === "string"
    );
  }
  return false;
}

/** JSON 输入在受理与物化阶段共用同一格式；递归过深等序列化失败不能逃成 500。 */
function serializeJsonInput(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? null : `${serialized}\n`;
  } catch {
    return null;
  }
}

export async function startRun(
  workflowId: string,
  inputs: Record<string, unknown>,
): Promise<StartRunResult> {
  const resolved = await resolveWorkflow(workflowId);
  if (!resolved) return { ok: false, status: 404, error: "工作流不存在" };
  return startResolvedRun(resolved, inputs, readSettings(), { source: "workflow" });
}

/**
 * 受理已经解析并由调用方检查过的完整执行快照。专用入口可把图、Action/Tool 定义、
 * 业务预检与实际执行绑定在同一个 ResolvedWorkflow 上；设置也在受理时冻结。
 */
export async function startResolvedRun(
  resolved: ResolvedWorkflow,
  inputs: Record<string, unknown>,
  settings: SettingsDocument,
  invocation: RunInvocationProvenance,
  completionGate?: RunCompletionGate,
): Promise<StartRunResult> {
  const issues = validateGraph(resolved.nodes, resolved.edges);
  for (const node of resolved.nodes) {
    try {
      assertSafeId("节点 id", node.id);
    } catch {
      issues.push({ nodeId: node.id, message: `节点「${node.label}」的 id 不能安全用于运行目录` });
    }
    if (node.kind === "action") {
      const actionId = resolved.nodeRows.get(node.id)?.actionId;
      if (!actionId || !resolved.actionDefinitions.has(actionId)) {
        issues.push({
          nodeId: node.id,
          message: `Action 节点「${node.label}」缺少可执行定义或模型`,
        });
      }
    }
  }

  // 每个输入节点都要有值，且 PortValue.kind 与节点 Object Type 的 kind 一致
  const runInputs: Record<string, PortValue> = {};
  for (const node of resolved.nodes) {
    if (node.kind !== "input") continue;
    const port = node.outputs[0];
    const value = inputs[node.id];
    if (value === undefined || value === null) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」缺少运行输入`,
      });
      continue;
    }
    if (!isPortValue(value)) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」的输入值不是合法的 PortValue`,
      });
      continue;
    }
    if (value.kind !== port.kind) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」需要 ${port.kind} 类型的值，收到 ${value.kind}`,
      });
      continue;
    }
    // file 输入的 path 来自不可信请求体，必须约束在 data/ 内（防目录穿越）
    if (value.kind === "file" && !isWithinData(value.file.path)) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」的文件路径非法（越界 data/ 目录）`,
      });
      continue;
    }
    // 文字/JSON 输入的尺寸上限在校验期就判，超限走 422 而不是拿到 runId 后
    // 才在物化阶段异步失败——确定性的输入违规不该伪装成引擎故障（file 类的
    // 上限在上传边界已限，materializeRunInputs 的检查是纵深兜底）。
    const serializedJson = value.kind === "json" ? serializeJsonInput(value.json) : null;
    if (value.kind === "json" && serializedJson === null) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」的 JSON 内容无法安全序列化`,
      });
      continue;
    }
    const inlineBytes =
      value.kind === "text"
        ? Buffer.byteLength(value.text, "utf8")
        : serializedJson === null
          ? 0
          : Buffer.byteLength(serializedJson, "utf8");
    if (inlineBytes > MAX_FILE_INPUT_BYTES) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」的内容超过 32 MiB`,
      });
      continue;
    }
    runInputs[node.id] = value;
  }

  if (issues.length > 0) {
    return { ok: false, status: 422, error: "工作流校验未通过", issues };
  }

  // 全局并发准入：每个运行都是一个独立子进程，无上限的对外调用会把机器拖垮。
  // 计数查库（含尚未 launch 的运行），且从查数到 insert 之间没有 await——
  // better-sqlite3 同步执行，两个并发 startRun 不会同时读到同一个空位。
  const runningIds = db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.status, "running"))
    .all()
    .map((row) => row.id);
  // cancelRun 会先写 cancelled，再等子进程与 finally 真正收束；这段窗口仍占一份
  // 运行时资源，不能因数据库终态提前释放准入名额。
  const active = new Set([...runningIds, ...activeRuns]).size;
  if (active >= MAX_CONCURRENT_RUNS) {
    return {
      ok: false,
      status: 429,
      error: `并行运行已达上限 ${MAX_CONCURRENT_RUNS}，请等待现有运行结束后重试`,
    };
  }

  const runId = crypto.randomUUID();
  try {
    db.insert(runs)
      .values({
        id: runId,
        workflowId: resolved.workflow.id,
        // 冗余快照：工作流后续改名，历史运行仍显示当时的名字
        workflowName: resolved.workflow.name,
        status: "running",
        // 入口来源与 run 同一次同步 insert 落库；专用 GET 不凭工作流名称猜来源。
        imports: { invocation },
        startedAt: new Date(),
      })
      .run();
  } catch (err) {
    // resolveWorkflow 的 await 与这次 insert 之间，工作流可能被并发 DELETE 掉
    //（删除守卫只挡有 running 运行的工作流）。外键失败在这里就是「工作流已不存在」，
    // 不能让对外 API 以 500 的面目报出来。
    if (err instanceof Error && err.message.includes("FOREIGN KEY constraint failed")) {
      return { ok: false, status: 404, error: "工作流不存在（可能刚被删除）" };
    }
    throw err;
  }
  for (const node of resolved.nodes) {
    db.insert(runNodes)
      .values({ runId, nodeId: node.id, label: node.label, status: "pending" })
      .run();
  }

  // 异步执行，立即返回 runId。activeRuns 覆盖 executeRun 启动前到异常兜底后的
  // 全部生命期；cancelRun 提前写下 cancelled 也不能让清理路径误判为已经静止。
  activeRuns.add(runId);
  void executeRun(runId, resolved, runInputs, settings, invocation, completionGate)
    .catch((err) => {
      failWholeRun(runId, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      const settlement = pendingUsageSettlements.get(runId);
      if (settlement) {
        // executeRun 已写终态，但用量尚未完整落库；保留进程句柄和 activeRuns，
        // 让预览、清理、删除与新准入继续 fail-closed，直到后台重试成功。
        void settlement.then(() => {
          if (pendingUsageSettlements.get(runId) !== settlement) return;
          pendingUsageSettlements.delete(runId);
          runProcesses.delete(runId);
          activeRuns.delete(runId);
        });
      } else if (!disposalFailures.has(runId)) {
        activeRuns.delete(runId);
      }
    });

  return { ok: true, runId };
}

/** 一次运行内同时执行的 Action 上限。扇出宽了也不会把并发无限放大。 */
const MAX_CONCURRENT_NODES = 10;

/**
 * 同时进行的运行总数上限。运行彼此独立（各自的工作区 + 子进程），并行本身
 * 是支持的；这个上限只是对外暴露 API 后的准入保护——超限返回 429 而不是排队，
 * 队列由外部调用方自己管。每个子进程是一份 node+tsx+dsh，内存以百 MB 计。
 */
const MAX_CONCURRENT_RUNS = 16;

type NodeStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

interface NodeState {
  node: ResolvedNode;
  status: NodeStatus;
  /** 已经执行过几轮；第 0 轮是首次执行 */
  round: number;
  outputs: Record<string, PortValue>;
  /** 完成时选中的出口名；undefined 表示还没跑完，null 表示默认出口 */
  selectedExit?: string | null;
}

/** 一条边的当前状态。dead 表示它的来源出口没有被选中，永远不会送来值。 */
type EdgeStatus = "pending" | "satisfied" | "dead";

/**
 * 图执行：就绪驱动、并行、按出口激活、按回边重入（ADR-0009）。
 *
 * 就绪判定只看**前向边**：环里的节点若同时等前驱和回边，第一轮永远等不齐。
 * 回边被满足时不参与就绪，而是触发目标节点的一次重入。
 */
async function executeRun(
  runId: string,
  resolved: ResolvedWorkflow,
  rawInputs: Record<string, PortValue>,
  globalSettings: SettingsDocument,
  invocation: RunInvocationProvenance,
  completionGate?: RunCompletionGate,
): Promise<void> {
  const { nodes, edges } = resolved;
  const { backEdgeIds } = classifyEdges(nodes, edges);
  const states = new Map<string, NodeState>(
    nodes.map((n) => [n.id, { node: n, status: "pending" as NodeStatus, round: 0, outputs: {} }]),
  );
  const edgeStatus = new Map<string, EdgeStatus>(edges.map((e) => [e.id, "pending"]));
  let firstError: string | null = null;
  let cancelled = false;

  // 工作区先建：它是这次运行全部 Action 的共同工作场所与唯一交流场所。
  // 技能以 symlink 指向全局库活目录，摘要写进 runs.imports（ADR-0007）。
  const capabilities = collectCapabilities(resolved);
  const workspace = await createRunWorkspace({
    workflowId: resolved.workflow.id,
    runId,
    instructions: workflowInstructions(resolved),
    skills: capabilities.skills,
  });
  db.update(runs)
    .set({
      runDir: path.relative(process.cwd(), workspace.runDir),
      // 工作区导入摘要稍后补齐，但不能覆盖受理时已经持久化的入口来源证明。
      imports: { ...workspace.imports, invocation } as unknown as Record<string, unknown>,
    })
    .where(eq(runs.id, runId))
    .run();

  // 全部输入落进工作区 inputs/：文件拷原件，文字与 JSON 写成文件（ADR-0012）。
  // 输入是这次运行最初的产物，与 Action 产物同一种读法；一切格式转换都是
  // Action 里模型自己的工作（ADR-0011）。
  if (isRunCancelled(runId)) {
    cancelledRuns.delete(runId);
    return;
  }
  const runInputs = materializeRunInputs(rawInputs, workspace, nodes);

  // 每个 Action 在开跑前把自己的落库上下文登记进来，事件回调据此把 dsh 事件
  // 即时写成 run_events / node_usage。
  const sinks = new Map<string, EventSinkContext>();
  // 设置已在准入时冻结：工作区创建期间发生的网页修改也只影响下一次运行。
  let proc: RunProcess;
  try {
    proc = await launchRun(workspace, {
      credentialRefs: globalSettings.credentialRefs.map((r) => r.name),
      composition: {
        deepseek: {
          apiKeyEnv: globalSettings.modelApiKeyEnv,
          ...(globalSettings.modelBaseUrl ? { baseURL: globalSettings.modelBaseUrl } : {}),
        },
        mcpServers: globalSettings.mcpServers,
        toolPlugins: materializeToolPlugins(workspace, capabilities.tools),
      },
      onCrash: (message) => {
        firstError ??= message;
      },
      onSessionEvent: (sessionId, event) => {
        const sink = sinks.get(sessionId);
        if (sink) {
          recordSessionEvent(sink, event);
          // 双重 teardown 失败后该会话仍可能发出付费用量；其节点汇总保持实时追增量。
          refreshUnsettledActionUsage(runId, sessionId);
        }
      },
    });
  } catch (error) {
    if (error instanceof UnsettledRunLaunchError) {
      // initialize 尚未返回时常规 proc 变量还不存在；异常携带的句柄是最后的
      // 所有权通道。保留它并把运行永久隔离到进程重启，所有清理与新准入 fail-closed。
      runProcesses.set(runId, error.runProcess);
      disposalFailures.add(runId);
      console.error("[engine] 初始化失败后的子进程收束失败", runId, error);
    }
    throw error;
  }
  runProcesses.set(runId, proc);

  /**
   * 一个入端口有没有前向入线。只被回边喂的端口（review-fix 里「意见」这种）
   * 第一轮本来就没有值，不能参与就绪判定，否则整个环第一轮就死锁。
   */
  const portHasForward = (nodeId: string, portName: string): boolean =>
    edges.some(
      (e) => !backEdgeIds.has(e.id) && e.targetNodeId === nodeId && e.targetPort === portName,
    );

  /**
   * 某个输入端口是否可以开跑：全部前向入线都已结算（satisfied 或 dead），
   * 且至少有一条 satisfied。
   *
   * 「全部结算」这一半是汇总的命根子：一个端口接六条入线时，只要有一条还没
   * 结算就不能开跑，否则节点会抢在其余上游之前启动、只读到已经落盘的那几份产物。
   * 实测中汇总节点正是这样漏读了一位评委的结论——六份产物都在磁盘上，它只读到五份。
   */
  const portFed = (nodeId: string, portName: string): boolean => {
    const forward = edges.filter(
      (e) => !backEdgeIds.has(e.id) && e.targetNodeId === nodeId && e.targetPort === portName,
    );
    if (forward.length === 0) return false;
    if (forward.some((e) => edgeStatus.get(e.id) === "pending")) return false;
    return forward.some((e) => edgeStatus.get(e.id) === "satisfied");
  };

  /** 某个输入端口是否已经没救：全部前向入线都 dead。 */
  const portDead = (nodeId: string, portName: string): boolean => {
    const forward = edges.filter(
      (e) => !backEdgeIds.has(e.id) && e.targetNodeId === nodeId && e.targetPort === portName,
    );
    return forward.length > 0 && forward.every((e) => edgeStatus.get(e.id) === "dead");
  };

  /**
   * 汇集一个节点各输入端口的值。一个端口可以接多条入线（那就是汇总），
   * 所以每个端口拿到的是一个**列表**——下游要读齐全部上游产物，不是只读一份。
   * 顺序按边 id 稳定，重跑时提示里的文件顺序不会晃。
   */
  const gatherInputs = (state: NodeState): Record<string, PortValue[]> => {
    const out: Record<string, PortValue[]> = {};
    const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const port of state.node.inputs) {
      const values: PortValue[] = [];
      for (const e of sorted) {
        if (e.targetNodeId !== state.node.id || e.targetPort !== port.name) continue;
        if (edgeStatus.get(e.id) !== "satisfied") continue;
        const value = states.get(e.sourceNodeId)?.outputs[e.sourcePort];
        if (value) values.push(value);
      }
      if (values.length > 0) out[port.name] = values;
    }
    return out;
  };

  /** 节点完成后：按选中的出口把出线标 satisfied，其余标 dead。 */
  const settleOutgoing = (state: NodeState): void => {
    for (const e of edges) {
      if (e.sourceNodeId !== state.node.id) continue;
      const port = state.node.outputs.find((p) => p.name === e.sourcePort);
      const exitName = port?.exitName ?? null;
      const taken = state.selectedExit === undefined || exitName === state.selectedExit;
      edgeStatus.set(e.id, taken && state.outputs[e.sourcePort] ? "satisfied" : "dead");
    }
  };

  /** 出线全 dead 的节点被跳过，并把 dead 继续往下传。 */
  const propagateSkips = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const state of states.values()) {
        if (state.status !== "pending") continue;
        if (!state.node.inputs.some((p) => portDead(state.node.id, p.name))) continue;
        state.status = "skipped";
        updateRunNode(runId, state.node.id, { status: "skipped", finishedAt: new Date() });
        for (const e of edges) {
          if (e.sourceNodeId === state.node.id) edgeStatus.set(e.id, "dead");
        }
        changed = true;
      }
    }
  };

  /** 回边被满足：把目标节点连同它的前向下游重置，进入下一轮。 */
  const reenter = (target: NodeState): boolean => {
    const limit = target.node.maxReentries ?? 0;
    if (target.round >= limit) {
      if ((target.node.onExhausted ?? "fail") === "fail") {
        target.status = "failed";
        const message = `节点「${target.node.label}」重入次数已达上限 ${limit}`;
        updateRunNode(runId, target.node.id, {
          status: "failed",
          error: message,
          finishedAt: new Date(),
        });
        firstError ??= message;
      }
      // accept：保留最后一轮的成功结果，回边不再跟进，循环自然收束。
      return false;
    }
    const affected = downstreamOf(target.node.id, edges, backEdgeIds);
    affected.add(target.node.id);
    // 整个环体一起进下一轮：只给被回流的节点加轮次的话，环里其他节点会用
    // 同一个产物路径把上一轮的东西覆盖掉，逐轮回看就没了依据。
    const nextRound = target.round + 1;
    for (const id of affected) {
      const state = states.get(id);
      if (!state) continue;
      state.status = "pending";
      state.selectedExit = undefined;
      state.round = nextRound;
      updateRunNode(runId, id, { status: "pending", error: null, finishedAt: null });
      for (const e of edges) {
        // 只重置环体内部的边：目标节点的入线保留刚满足的那条回边；来自环外
        // 已完成节点的入线保持已结算——那些源不会重跑，重置它们会让环内节点
        // 的该端口在下一轮永远等不齐（实测：题目输入同时喂环内写码与测试两个
        // 节点的图，第一次回流即整环死锁）。
        if (
          affected.has(e.targetNodeId) &&
          e.targetNodeId !== target.node.id &&
          affected.has(e.sourceNodeId)
        ) {
          edgeStatus.set(e.id, "pending");
        }
      }
    }
    return true;
  };

  /** 一个节点跑完（成功）后的统一收尾：落库、结算出线、传播跳过、处理回边。 */
  const onNodeSuccess = (state: NodeState): void => {
    updateRunNode(runId, state.node.id, {
      status: "success",
      outputs: state.outputs,
      finishedAt: new Date(),
    });
    state.status = "success";
    settleOutgoing(state);
    propagateSkips();
    for (const e of edges) {
      if (!backEdgeIds.has(e.id)) continue;
      if (e.sourceNodeId !== state.node.id) continue;
      if (edgeStatus.get(e.id) !== "satisfied") continue;
      const target = states.get(e.targetNodeId);
      if (target) reenter(target);
    }
  };

  /** 挑出此刻可以开跑的节点。 */
  const pickReady = (): NodeState[] => {
    const ready: NodeState[] = [];
    for (const state of states.values()) {
      if (state.status !== "pending") continue;
      if (state.node.kind === "input") {
        ready.push(state);
        continue;
      }
      const blocking = state.node.inputs.filter((p) => portHasForward(state.node.id, p.name));
      if (blocking.every((p) => portFed(state.node.id, p.name))) ready.push(state);
    }
    return ready.sort((a, b) => (a.node.id < b.node.id ? -1 : 1));
  };

  const runOne = async (state: NodeState): Promise<void> => {
    const nodeId = state.node.id;
    if (state.node.kind === "input") {
      updateRunNode(runId, nodeId, { status: "running", startedAt: new Date() });
      const value = runInputs[nodeId];
      if (!value) throw new Error("输入节点缺少运行输入");
      state.outputs = { value };
      onNodeSuccess(state);
      return;
    }

    const nodeInputs = gatherInputs(state);
    for (const port of state.node.inputs) {
      // 只被回边喂的端口第一轮没有值是正常的，不算缺输入。
      if (!portHasForward(nodeId, port.name)) continue;
      if (!nodeInputs[port.name]?.length) {
        throw new Error(`输入端口「${port.name}」没有可用的上游值`);
      }
    }
    updateRunNode(runId, nodeId, {
      status: "running",
      startedAt: new Date(),
      inputs: nodeInputs,
      error: null,
    });

    if (state.node.kind === "output") {
      // 输出节点只有一个 value 口，透传第一份（多条入线的输出节点没有意义）。
      state.outputs = { value: nodeInputs.value[0] };
      onNodeSuccess(state);
      return;
    }

    const nodeRow = resolved.nodeRows.get(nodeId);
    if (!nodeRow?.actionId) throw new Error("Action 节点缺少 actionId");
    const definition = resolved.actionDefinitions.get(nodeRow.actionId);
    if (!definition) throw new Error(`Action 节点「${state.node.label}」缺少受理时定义快照`);
    const result = await runActionNode({
      runId,
      node: state.node,
      definition,
      inputs: nodeInputs,
      proc,
      workspace,
      sinks,
      round: state.round,
      toolFilter: toolFilterForAction(
        capabilities,
        nodeRow.actionId,
        globalSettings.disabledTools,
      ),
    });
    // cancelRun 可能在 Action 已产出、但会话仍在收束的 await 窗口落下终态。
    // 这里必须在写成功前再查一次，否则晚到的 Action 返回会把 cancelled 覆盖成 success。
    if (isRunCancelled(runId)) throw new Error("运行已取消");
    state.outputs = result.outputs;
    state.selectedExit = result.selectedExit;
    onNodeSuccess(state);
  };

  try {
    const running = new Map<string, Promise<void>>();
    for (;;) {
      if (isRunCancelled(runId)) {
        cancelled = true;
        break;
      }
      // 有节点失败后不再启动新节点，但已在跑的等它们自己收束。
      if (firstError === null) {
        for (const state of pickReady()) {
          if (running.size >= MAX_CONCURRENT_NODES) break;
          state.status = "running";
          const task = runOne(state)
            .catch((err) => {
              if (isRunCancelled(runId)) {
                state.status = "cancelled";
                updateRunNode(runId, state.node.id, {
                  status: "cancelled",
                  finishedAt: new Date(),
                });
                cancelled = true;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              state.status = "failed";
              updateRunNode(runId, state.node.id, {
                status: "failed",
                error: message,
                finishedAt: new Date(),
              });
              firstError ??= `节点「${state.node.label}」失败：${message}`;
              for (const e of edges) {
                if (e.sourceNodeId === state.node.id) edgeStatus.set(e.id, "dead");
              }
              propagateSkips();
            })
            .finally(() => {
              running.delete(state.node.id);
            });
          running.set(state.node.id, task);
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
  } finally {
    // 无论成败都把子进程收束到静止：一个运行的进程树不许活过它的运行。
    try {
      await proc.dispose();
      try {
        finalizeUnsettledActionUsage(runId);
        runProcesses.delete(runId);
      } catch (usageError) {
        firstError ??=
          `运行子进程退出后的用量结算失败：${
            usageError instanceof Error ? usageError.message : String(usageError)
          }`;
        console.error("[engine] 退出后的用量结算失败", runId, usageError);
        scheduleUsageSettlementRetry(runId);
      }
      disposalFailures.delete(runId);
    } catch (err) {
      // dispose 已含 SIGTERM→SIGKILL；它仍报错就不能再宣称工作区无人写入。
      // 保留进程句柄与 activeRuns 所有权，所有读取/删除/新准入继续 fail-closed。
      disposalFailures.add(runId);
      firstError ??= `运行子进程无法确认已退出：${err instanceof Error ? err.message : String(err)}`;
      console.error("[engine] 子进程收束失败", runId, err);
    }
  }

  // 专用调用入口可在引擎写 success 前复核业务完成条件。证据只有在复核通过后
  // 才与运行元数据一起持久化；事件日志随后可按保留策略清理，不会让既有成功运行
  // 失去读取依据。回调或证据落库失败都把本次运行收束为 failed。
  if (!cancelled && !isRunCancelled(runId) && firstError === null && completionGate) {
    try {
      const completion = completionGate(runId);
      if (!completion.ok) {
        firstError = `运行完成校验失败：${completion.error}`;
      } else {
        const row = db
          .select({ imports: runs.imports })
          .from(runs)
          .where(eq(runs.id, runId))
          .get();
        if (!row) throw new Error("运行记录不存在");
        db.update(runs)
          .set({
            imports: {
              ...(row.imports ?? {}),
              completion: completion.evidence,
            },
          })
          .where(eq(runs.id, runId))
          .run();
      }
    } catch (error) {
      firstError = `运行完成校验失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // 终态判定：cancelled 与 failed 是两个独立终态，取消不算失败、run.error 留空
  const writeTerminalState = (): void => {
    const now = new Date();
    if (cancelled || isRunCancelled(runId)) {
      db.update(runNodes)
        .set({ status: "skipped", finishedAt: now })
        .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "pending")))
        .run();
      db.update(runs)
        .set({ status: "cancelled", error: null, finishedAt: now })
        .where(eq(runs.id, runId))
        .run();
      return;
    }
    db.update(runNodes)
      .set({ status: "skipped", finishedAt: now })
      .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "pending")))
      .run();
    // 输出节点标记的是工作流级最终产出。分支图里没走到的输出节点被跳过是正常的，
    // 但一个都没走到就说明这次运行什么都没产出——那不叫成功。循环按 accept 收束
    // 却始终没走出通过分支，就会落到这里。
    const outputNodes = nodes.filter((n) => n.kind === "output");
    const producedAny = outputNodes.some((n) => states.get(n.id)?.status === "success");
    if (firstError === null && outputNodes.length > 0 && !producedAny) {
      firstError = "运行结束时没有任何输出节点产出：图上所有通往输出的分支都没有走到";
    }
    db.update(runs)
      .set(
        firstError
          ? { status: "failed", error: firstError, finishedAt: now }
          : { status: "success", finishedAt: now },
      )
      .where(eq(runs.id, runId))
      .run();
  };
  try {
    writeTerminalState();
  } catch (err) {
    // 清理面板的 VACUUM 之类长写锁可能顶穿 busy_timeout。终态绝不能因此丢——
    // 否则 run 卡在 running：占死一个并发名额、SSE 永不结束，直到进程重启对账。
    // 等一拍再试一次；仍失败则抛给 startRun 的兜底（failWholeRun 自身也带重试）。
    console.error("[engine] 终态落库失败，1.5 秒后重试", runId, err);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeTerminalState();
  }
  cancelledRuns.delete(runId);
}

/**
 * 取消运行：取消子进程里所有 running 节点的会话，把它们标 cancelled、
 * 未开始的节点标 skipped、run 标 cancelled。同时立进程级取消标记，让
 * executeRun 在下一个节点开始前停止调度。HTTP 入口在阶段二接。
 */
export async function cancelRun(runId: string): Promise<CancelRunResult> {
  const run = db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (!run) return { ok: false, status: 404, error: "运行不存在" };
  if (run.status !== "running") {
    return { ok: false, status: 409, error: "该运行已结束，无法取消" };
  }

  // 先立标记：即使下面的会话取消慢，executeRun 也不会再启动新节点
  cancelledRuns.add(runId);

  const running = db
    .select({ nodeId: runNodes.nodeId, sessionId: runNodes.sessionId })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "running")))
    .all();

  const proc = runProcesses.get(runId);
  for (const node of running) {
    if (!node.sessionId || !proc) continue;
    try {
      await proc.cancel(node.sessionId);
    } catch (err) {
      // 子进程可能已随崩溃退出；取消的权威结果是下面写下的终态，不是这次调用。
      console.error("[engine] 取消会话失败", node.sessionId, err);
    }
  }

  const now = new Date();
  db.update(runNodes)
    .set({ status: "cancelled", finishedAt: now })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "running")))
    .run();
  db.update(runNodes)
    .set({ status: "skipped", finishedAt: now })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "pending")))
    .run();
  db.update(runs)
    .set({ status: "cancelled", error: null, finishedAt: now })
    .where(eq(runs.id, runId))
    .run();

  return { ok: true };
}

function updateRunNode(
  runId: string,
  nodeId: string,
  patch: Partial<typeof runNodes.$inferInsert>,
): void {
  db.update(runNodes)
    .set(patch)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
    .run();
}

/** 兜底：executeRun 自身抛出的异常也不留 running 悬挂；落库失败自身有界重试 */
function failWholeRun(runId: string, message: string, attempt = 0): void {
  try {
    const wasCancelled = cancelledRuns.has(runId);
    cancelledRuns.delete(runId);
    if (wasCancelled) return;
    // 已经写过终态（含被取消）的运行不覆盖：取消不是失败
    const run = db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    if (!run || run.status !== "running") return;

    db.update(runNodes)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(
        and(eq(runNodes.runId, runId), eq(runNodes.status, "running")),
      )
      .run();
    db.update(runNodes)
      .set({ status: "skipped", finishedAt: new Date() })
      .where(
        and(
          eq(runNodes.runId, runId),
          inArray(runNodes.status, ["pending"]),
        ),
      )
      .run();
    db.update(runs)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(runs.id, runId))
      .run();
  } catch (err) {
    console.error("[engine] 运行失败状态落库失败", err);
    // 这是终态的最后防线：吞掉异常就等于把 run 永久留在 running。
    // 有界重试两次，扛过清理 VACUUM 这类秒级长写锁。
    if (attempt < 2) {
      setTimeout(() => failWholeRun(runId, message, attempt + 1), 2000);
    }
  }
}

/**
 * 工作流级共同指令，物化为工作区的 AGENTS.md。
 * 上游 agent-instructions 从会话 cwd 向上发现它，因此这次运行的每个 Action
 * 都无条件读到同一份（对应「在项目文件夹里起 agent」的体验）。
 */
function workflowInstructions(resolved: ResolvedWorkflow): string {
  const lines = [
    `# ${resolved.workflow.name}`,
    "",
    "你是这个工作流里的一个 Action。本目录是本次运行的工作区，也是各 Action 之间",
    "唯一的交流场所：实质内容一律写成文件，读上游的东西也一律读文件。",
    "",
    "- 产物只写在本目录内；沙箱只放行工作区与系统临时目录的写入。",
    "- 输入文件都是原件，没有做过任何预处理；读不动的格式就用 bash 自己转换。",
    "- 结构化输出只用来报告产物路径，不要往里塞长文本。",
    "- 声明了的产物必须真的写出来：文件不存在，本节点即判失败。",
  ];
  if (resolved.workflow.description) {
    lines.splice(2, 0, resolved.workflow.description, "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 把全部运行输入物化进工作区的 inputs/ 并改写 PortValue 为文件引用（ADR-0012）。
 * 文件类拷原件（上传目录在工作区之外，模型的 cwd 是工作区，不搬进来读不到）；
 * 文字与 JSON 写成 Markdown / JSON 文件——输入是这次运行最初的产物，提示里
 * 只给路径不内联，超长文本被截断喂给模型这类特判缺陷从根上消失。
 * 只拷原件不做任何转换：格式处理是 Action 里模型用 bash 自己的工作（ADR-0011）。
 */
function materializeRunInputs(
  inputs: Record<string, PortValue>,
  workspace: RunWorkspace,
  nodes: readonly ResolvedNode[],
): Record<string, PortValue> {
  const out: Record<string, PortValue> = {};
  for (const [nodeId, value] of Object.entries(inputs)) {
    // nodeId 来自持久化工作流；writer 已校验，这里在真正进入路径前再守一次旧数据。
    assertSafeId("输入节点 id", nodeId);
    const destDir = path.join(workspace.workspaceDir, WORKSPACE_INPUTS_SUBDIR, nodeId);
    fs.mkdirSync(destDir, { recursive: true });

    if (value.kind === "file") {
      const name = boundedInputFilename(value.file.name || value.file.path);
      const dest = path.join(destDir, name);
      const source = resolveWithinData(value.file.path);
      if (fs.statSync(source).size > MAX_FILE_INPUT_BYTES) {
        throw new Error(`输入节点「${nodeId}」的文件超过 32 MiB`);
      }
      fs.copyFileSync(source, dest);
      out[nodeId] = {
        kind: "file",
        file: { path: path.relative(DATA_DIR, dest), name, mime: value.file.mime },
      };
      continue;
    }

    // 文字与 JSON 物化为文件（ADR-0012）：按节点名命名，路径本身就是语义，
    // 模型和事后翻工作区的人都能一眼认出这是什么。文字一字不差落盘，不加不减。
    const label = nodes.find((node) => node.id === nodeId)?.label.trim() ?? "";
    const stem = safeBasename(label || "value");
    const name = boundedInputFilename(value.kind === "text" ? `${stem}.md` : `${stem}.json`);
    const content = value.kind === "text" ? value.text : serializeJsonInput(value.json);
    if (content === null) {
      throw new Error(`输入节点「${nodeId}」的 JSON 内容无法安全序列化`);
    }
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_INPUT_BYTES) {
      throw new Error(`输入节点「${nodeId}」的内容超过 32 MiB`);
    }
    const dest = path.join(destDir, name);
    fs.writeFileSync(dest, content, "utf8");
    out[nodeId] = {
      kind: "file",
      file: {
        path: path.relative(DATA_DIR, dest),
        name,
        mime: value.kind === "text" ? "text/markdown" : "application/json",
      },
    };
  }
  return out;
}
