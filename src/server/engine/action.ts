/**
 * 单个 Action 的执行：在本次运行的 harness 子进程里开一个会话，让它读上游产物、
 * 写自己的产物，并以 structured_output 交出数据面（ADR-0006 / ADR-0008）。
 *
 * - 实质内容一律走工作区文件。连线不搬运内容，只在提示里生成「去读哪个文件」。
 * - 数据面 schema 由输出端口生成：每个输出端口一个字段，值是该端口产物的实际路径。
 * - 产物没写出来是唯一的机械兜底：文件不存在即节点失败，不管模型说了什么。
 * - 会话创建前把本次实际使用的完整配置冻结进 run_nodes.snapshot（运行快照），
 *   端口与 prompt/rule/model/思考强度一样在**执行时刻**重查，保证快照内部同源同刻。
 */
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  actionPorts,
  actionSkills,
  actions,
  db,
  models,
  nodeUsage,
  objectTypes,
  runEvents,
  runNodes,
  skills,
} from "@/db";
import { exitsOf, hasNamedExits, type ResolvedNode, type ResolvedPort } from "@/lib/graph";
import type { PortValue } from "@/lib/values";
import { DATA_DIR } from "@/server/fs-safety";
import type { NodeToolFilter } from "@/server/harness/rpc/types";
import type { RunProcess } from "@/server/harness/runtime";
import type { RunWorkspace } from "@/server/harness/workspace";
import type { NodeExit } from "@/lib/graph";
import {
  clearUnpersistedUsageForSession,
  unpersistedUsageForSession,
  type EventSinkContext,
} from "./events";
// 循环依赖（runner → action → runner）在 ESM 下安全：isRunCancelled 是函数声明，
// 且只在 runActionNode 执行期调用，那时 runner 模块体早已求值完毕。
import { isRunCancelled } from "./runner";

export interface ActionNodeContext {
  runId: string;
  node: ResolvedNode;
  actionId: string;
  /**
   * 入端口名 → 上游交来的值**列表**。一个端口可以接多条入线（汇总），
   * 因此这里恒是列表；只被回边喂的端口在第一轮直接缺席。
   */
  inputs: Record<string, PortValue[]>;
  /** 本次运行独占的 harness 子进程 */
  proc: RunProcess;
  workspace: RunWorkspace;
  /** 会话事件落库上下文表：本节点开跑前把自己登记进去 */
  sinks: Map<string, EventSinkContext>;
  /** 第几轮执行；0 是首次，>0 说明本节点被回边重入了（ADR-0009） */
  round: number;
  /** 本 Action 的会话工具面：未引用的工作流 Tool 与全局停用项都在这里收窄。 */
  toolFilter?: NodeToolFilter;
}

/** 一次 Action 执行的结果：产物值加它走的那个出口。 */
export interface ActionNodeResult {
  outputs: Record<string, PortValue>;
  /** 选中的出口名；null 表示这个 Action 没有具名出口 */
  selectedExit: string | null;
}

/** 运行快照里的端口定义（只留展示所需，不留 id——实体删了也照样读得懂） */
export interface RunSnapshotPort {
  name: string;
  objectTypeName: string;
  kind: "text" | "file" | "json";
  /** 输出端口的产物路径（相对工作区，含本轮的 rounds/ 前缀） */
  artifactPath?: string;
  /** 输出端口所属的具名出口 */
  exitName?: string;
}

/** run_nodes.snapshot 的结构：该节点本次执行实际使用的完整配置 */
export interface RunSnapshot {
  actionId: string;
  actionName: string;
  prompt: string;
  rule: string;
  model: { providerId: string; modelId: string; displayName: string };
  reasoningEffort: "off" | "low" | "high" | "max";
  skills: Array<{ name: string; content: string }>;
  ports: { inputs: RunSnapshotPort[]; outputs: RunSnapshotPort[] };
  /** 本次执行发给模型的完整提示，含上游产物指引与产物要求 */
  renderedPrompt: string;
}

/** 单个 Action 的会话在收束前允许的墙钟上限。 */
const NODE_TURN_TIMEOUT_MS = 900_000;

/**
 * 单个 Action 一轮允许的最大步数。上游没有这个上限，只有墙钟兜底；
 * 一个开始空转的 agent 能烧掉整整十五分钟的 token 才被拦下。
 */
const NODE_MAX_STEPS = 40;

interface UsageAmounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

interface UnsettledUsageRollup {
  runId: string;
  nodeId: string;
  sessionId: string;
  modelId: string;
  /** 本会话开始前节点已经结算的历史轮次；后续刷新都从这个固定基线重算。 */
  base: UsageAmounts;
  lastSession?: UsageAmounts & { chunks: number };
  detailPersistenceFailures: number;
  eventId?: number;
  eventDirty: boolean;
  /** true 仅表示双重 teardown 失败后仍可能继续收到 usage。 */
  unsettledProcess: boolean;
}

const actionUsageStore = globalThis as typeof globalThis & {
  ontoflowUnsettledUsageRollups?: Map<string, UnsettledUsageRollup>;
};
const unsettledUsageRollups =
  actionUsageStore.ontoflowUnsettledUsageRollups ??
  new Map<string, UnsettledUsageRollup>();
actionUsageStore.ontoflowUnsettledUsageRollups = unsettledUsageRollups;

export async function runActionNode(
  ctx: ActionNodeContext,
): Promise<ActionNodeResult> {
  assertNotCancelled(ctx.runId);

  const action = db.select().from(actions).where(eq(actions.id, ctx.actionId)).get();
  if (!action) throw new Error(`Action 已不存在：${ctx.actionId}`);
  const model = db.select().from(models).where(eq(models.id, action.modelId)).get();
  if (!model) throw new Error(`Action「${action.name}」引用的模型已不存在`);

  const ports = readActionPorts(ctx.actionId);
  assertPortsUnchanged(ctx.node, ports);

  const skillRows = readActionSkills(ctx.actionId);

  const outputPorts = ports.outputs.map((port) => ({
    ...port,
    // 第 N 轮的产物落进 rounds/N/，不覆盖上一轮：上一轮的东西是下一轮的输入，
    // 也是事后逐轮回看的唯一依据（ADR-0009）。
    artifactPath: port.artifactPath === null ? null : roundPath(port.artifactPath, ctx.round),
  }));
  for (const port of outputPorts) {
    if (!port.artifactPath) {
      throw new Error(
        `Action「${action.name}」的输出端口「${port.name}」没有产物路径；` +
          `内容走工作区文件后每个输出端口都必须声明它写到哪（ADR-0008）`,
      );
    }
  }
  const exits = exitsOf({ ...ctx.node, outputs: outputPorts as ResolvedPort[] });
  const branching = hasNamedExits(ctx.node);

  const renderedPrompt = buildPrompt(
    action.prompt,
    action.rule,
    ctx.inputs,
    { inputs: ports.inputs, outputs: outputPorts },
    exits,
    branching,
    ctx.round,
  );

  const snapshot: RunSnapshot = {
    actionId: action.id,
    actionName: action.name,
    prompt: action.prompt,
    rule: action.rule,
    model: {
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
    },
    reasoningEffort: action.reasoningEffort,
    skills: skillRows.map((s) => ({ name: s.name, content: s.content })),
    ports: {
      inputs: ports.inputs.map(toSnapshotPort),
      // 输出记本轮真实生效的路径（含 rounds/ 前缀）与出口归属，
      // 否则快照解释不了「那一轮的东西到底写在哪」。
      outputs: outputPorts.map(toSnapshotPort),
    },
    renderedPrompt,
  };
  writeSnapshot(ctx, snapshot);

  // 一个 Action 的一轮执行独占一次会话（CONTEXT.md「会话」）。循环的每一轮都是
  // 全新的会话，不靠会话记忆延续，因此 id 要带上轮次。
  const sessionId = ctx.round === 0 ? ctx.node.id : `${ctx.node.id}#${ctx.round + 1}`;
  // 登记要先于 runTurn：事件从第一个 chunk 起就会回调过来。
  ctx.sinks.set(sessionId, {
    runId: ctx.runId,
    nodeId: ctx.node.id,
    sessionId,
    providerId: model.providerId,
    modelId: model.modelId,
    reasoningEffort: action.reasoningEffort,
  });
  // 会话 id 必须先落库再发 prompt：cancelRun 只从 running 节点读取待取消会话，
  // 若等 runTurn 收束后才写，这十五分钟内的活跃会话就永远取消不到。
  db.update(runNodes)
    .set({ sessionId })
    .where(and(eq(runNodes.runId, ctx.runId), eq(runNodes.nodeId, ctx.node.id)))
    .run();
  assertNotCancelled(ctx.runId);

  let usageMayContinue = false;

  try {
    await ctx.proc.runTurn(
      sessionId,
      [{ type: "text", text: renderedPrompt }],
      {
        agentOptions: { provider: model.providerId, model: model.modelId },
        nodeOptions: {
          outputSchema: buildOutputSchema(exits, branching),
          reasoningEffort: action.reasoningEffort,
          maxSteps: NODE_MAX_STEPS,
          ...(ctx.toolFilter === undefined ? {} : { toolFilter: ctx.toolFilter }),
        },
        timeoutMs: NODE_TURN_TIMEOUT_MS,
      },
    );
  } catch (turnError) {
    // runTurn 的墙钟超时只会停止 Next 侧等待，不会自动停止 agent。先关闭并等待
    // 该会话真正静止，之后 finally 才能做最终用量汇总；否则并行兄弟节点仍在跑时，
    // 这个超时会话还能继续产生费用，却再也没有第二次汇总机会。
    try {
      await ctx.proc.closeSession(sessionId);
    } catch (closeError) {
      // 单会话无法收束时只能收走本运行独占的整个子进程；这会让并行兄弟失败，
      // 但能保证用量结算后不再有后台会话继续计费。
      try {
        await ctx.proc.dispose();
      } catch (disposeError) {
        usageMayContinue = true;
        throw new AggregateError(
          [turnError, closeError, disposeError],
          `会话 ${sessionId} 失败后无法收束运行子进程`,
        );
      }
      throw new AggregateError(
        [turnError, closeError],
        `会话 ${sessionId} 失败后只能关闭运行子进程`,
      );
    }
    throw turnError;
  } finally {
    if (usageMayContinue) {
      // 子进程仍可能继续发 usage：用固定基线重算并保持实时刷新，不能在这里假装最终结算。
      beginUnsettledUsageRollup(ctx, sessionId, model);
    } else {
      // 失败分支已先把会话或进程收束到静止；此处求和之后不会再有迟到 usage。
      recordUsage(ctx, sessionId, model);
    }
  }

  assertNotCancelled(ctx.runId);

  const captured = await ctx.proc.sessionOutput(sessionId);
  if (!captured.captured) {
    throw new Error(
      `Action「${action.name}」没有调用 structured_output 交出结果；` +
        `会话已收束但数据面为空（也可能是步数超过上限 ${NODE_MAX_STEPS} 被拦下）`,
    );
  }

  const selectedExit = pickExit(action.name, exits, branching, captured.value);
  const produced = exits.find((e) => e.name === selectedExit)?.ports ?? [];
  const outputs = collectArtifacts(action.name, produced, ctx.workspace);
  // 会话用完即关：同一子进程里后续节点各自开自己的会话，互不可见。
  await ctx.proc.closeSession(sessionId);
  return { outputs, selectedExit };
}

/** 第 0 轮用声明的原路径，之后落进 rounds/<轮次>/ 下的同名路径。 */
function roundPath(artifactPath: string, round: number): string {
  return round === 0 ? artifactPath : path.posix.join("rounds", String(round + 1), artifactPath);
}

/**
 * 从数据面结果里读出这次走的是哪个出口。
 * 没有具名出口的 Action 只有唯一答案，不问模型。
 */
function pickExit(
  actionName: string,
  exits: NodeExit[],
  branching: boolean,
  value: unknown,
): string | null {
  if (!branching) return null;
  const chosen = (value as Record<string, unknown> | undefined)?.exit;
  if (typeof chosen !== "string" || !exits.some((e) => e.name === chosen)) {
    throw new Error(
      `Action「${actionName}」没有报告合法的出口：期望 ${exits
        .map((e) => `「${String(e.name)}」`)
        .join(" / ")}，实际收到 ${JSON.stringify(chosen)}`,
    );
  }
  return chosen;
}

function assertNotCancelled(runId: string): void {
  if (isRunCancelled(runId)) throw new Error("运行已取消");
}

function readActionPorts(actionId: string): {
  inputs: ActionPortRow[];
  outputs: ActionPortRow[];
} {
  const rows = db
    .select({
      name: actionPorts.name,
      direction: actionPorts.direction,
      objectTypeId: actionPorts.objectTypeId,
      artifactPath: actionPorts.artifactPath,
      exitName: actionPorts.exitName,
      objectTypeName: objectTypes.name,
      kind: objectTypes.kind,
    })
    .from(actionPorts)
    .innerJoin(objectTypes, eq(actionPorts.objectTypeId, objectTypes.id))
    .where(eq(actionPorts.actionId, actionId))
    .orderBy(asc(actionPorts.position))
    .all();
  return {
    inputs: rows.filter((r) => r.direction === "input"),
    outputs: rows.filter((r) => r.direction === "output"),
  };
}

interface ActionPortRow {
  name: string;
  direction: "input" | "output";
  objectTypeId: string;
  artifactPath: string | null;
  exitName: string | null;
  objectTypeName: string;
  kind: "text" | "file" | "json";
}

function readActionSkills(actionId: string): Array<typeof skills.$inferSelect> {
  const ids = db
    .select({ skillId: actionSkills.skillId })
    .from(actionSkills)
    .where(eq(actionSkills.actionId, actionId))
    .all()
    .map((r) => r.skillId);
  if (ids.length === 0) return [];
  return db.select().from(skills).where(inArray(skills.id, ids)).all();
}

/**
 * 端口在执行时刻重查，与运行快照同源同刻。图解析之后端口被改过就中止：
 * 运行快照解释不了的输出不如不产出（ADR-0007 的运行自包含要求）。
 */
function assertPortsUnchanged(
  node: ResolvedNode,
  ports: { inputs: ActionPortRow[]; outputs: ActionPortRow[] },
): void {
  const same = (a: ResolvedPort[], b: ActionPortRow[]): boolean =>
    a.length === b.length &&
    a.every(
      (p, i) =>
        p.name === b[i].name &&
        p.objectTypeId === b[i].objectTypeId &&
        (p.artifactPath ?? null) === b[i].artifactPath &&
        (p.exitName ?? null) === b[i].exitName,
    );
  if (!same(node.inputs, ports.inputs) || !same(node.outputs, ports.outputs)) {
    throw new Error(
      `节点「${node.label}」的端口在运行开始后被改动，本次运行中止：` +
        `运行快照无法解释改动之后产出的结果`,
    );
  }
}

function toSnapshotPort(port: {
  name: string;
  objectTypeName: string;
  kind: "text" | "file" | "json";
  artifactPath?: string | null;
  exitName?: string | null;
}): RunSnapshotPort {
  return {
    name: port.name,
    objectTypeName: port.objectTypeName,
    kind: port.kind,
    ...(port.artifactPath ? { artifactPath: port.artifactPath } : {}),
    ...(port.exitName ? { exitName: port.exitName } : {}),
  };
}

function writeSnapshot(ctx: ActionNodeContext, snapshot: RunSnapshot): void {
  db.update(runNodes)
    .set({ snapshot: snapshot as unknown as Record<string, unknown> })
    .where(and(eq(runNodes.runId, ctx.runId), eq(runNodes.nodeId, ctx.node.id)))
    .run();
}

/**
 * 组装发给模型的完整提示：任务、上游产物指引、必须写出的产物、出口选择、执行规则。
 * `{{端口名}}` 占位符插值为该入端口的取用说明（文件读路径或字面值）。
 */
function buildPrompt(
  prompt: string,
  rule: string,
  inputs: Record<string, PortValue[]>,
  ports: { inputs: ActionPortRow[]; outputs: ResolvedPort[] },
  exits: NodeExit[],
  branching: boolean,
  round: number,
): string {
  const sections: string[] = [interpolate(prompt, inputs)];

  if (round > 0) {
    sections.push(
      `## 这是第 ${round + 1} 轮\n\n你之前跑过 ${round} 轮，本轮的产物写在 ` +
        `\`rounds/${round + 1}/\` 下。上一轮的产物与针对它的意见都在工作区里，` +
        `路径见下面「你要读的东西」——先读完再动手，不要凭空重来。`,
    );
  }

  if (ports.inputs.length > 0) {
    const lines = ports.inputs.flatMap((port) => {
      const values = inputs[port.name] ?? [];
      if (values.length === 0) return [`- ${port.name}（${port.objectTypeName}）：本轮没有`];
      if (values.length === 1) {
        return [`- ${port.name}（${port.objectTypeName}）：${describeInput(values[0])}`];
      }
      // 汇总：这个口接了多条入线，下游要读齐全部产物，逐条列出来。
      return [
        `- ${port.name}（${port.objectTypeName}）：共 ${values.length} 份，都要读`,
        ...values.map((v) => `  - ${describeInput(v)}`),
      ];
    });
    sections.push(`## 你要读的东西\n\n${lines.join("\n")}`);
  }

  if (branching) {
    const exitLines = exits.map((exit) => {
      const artifacts = exit.ports
        .map((p) => `\`${String(p.artifactPath)}\`（${p.objectTypeName}）`)
        .join("、");
      return `- **${String(exit.name)}**：走这个出口就写出 ${artifacts}`;
    });
    sections.push(
      `## 你要选的出口\n\n本节点有多个出口，只能走一个。在 structured_output 的 ` +
        `\`exit\` 字段里报告你走的是哪个，并且只写出那个出口的产物：\n\n${exitLines.join("\n")}`,
    );
  } else {
    const outLines = exits
      .flatMap((e) => e.ports)
      .map((port) => `- \`${String(port.artifactPath)}\`（${port.objectTypeName}）`);
    sections.push(
      `## 你要写的东西\n\n把实质内容写进下面这些文件（路径相对当前目录）：\n\n${outLines.join("\n")}`,
    );
  }

  sections.push(
    `写完后调用 structured_output，每个产物字段填你实际写出的那个路径。` +
      `不要把长文本塞进 structured_output——下游只需要工作区里的产物路径。`,
  );

  if (rule.trim()) sections.push(`## 执行规则\n\n${rule.trim()}`);
  return sections.join("\n\n");
}

/**
 * 一个入端口的取用说明：文件只给路径；内联值说明输入物化层失守，直接失败。
 * 文件类运行输入一律是原件——平台不做任何格式预处理，转换（抽文本、栅格化、
 * OCR 等）是模型在会话里用 bash 自己的工作（ADR-0011 / ADR-0012）。
 */
function describeInput(value: PortValue | undefined): string {
  if (!value) return "（上游未提供）";
  switch (value.kind) {
    case "file":
      return (
        `读文件 \`${workspaceRelative(value.file.path)}\`（原件，未经预处理；` +
        `直接读不动的格式就用 bash 自行转换成能读的形态）`
      );
    case "text":
    case "json":
      // ADR-0012 后运行输入一律在启动时物化为文件，引擎内不该再出现内联值；
      // 走到这里即物化层缺陷，宁可响亮失败也不能再把可能被截断的内容喂给模型。
      throw new Error("运行输入未物化为文件（ADR-0012），拒绝内联进提示");
  }
}

/**
 * 把 data/ 相对路径转成工作区相对路径。上游产物就落在本次运行的工作区里，
 * 因此提示里给的是模型 cwd 下的相对路径，而不是绝对路径。
 */
function workspaceRelative(dataRelPath: string): string {
  const marker = `${path.sep}workspace${path.sep}`;
  const idx = dataRelPath.indexOf(marker);
  return idx === -1 ? dataRelPath : dataRelPath.slice(idx + marker.length);
}

function interpolate(text: string, inputs: Record<string, PortValue[]>): string {
  let out = text;
  for (const [name, values] of Object.entries(inputs)) {
    out = out.replace(
      new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, "g"),
      values.map((v) => describeInput(v)).join("、"),
    );
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 数据面 schema：每个输出端口一个字段，值是该端口产物的实际路径；有具名出口时
 * 再加一个必填的 `exit`。实质内容不进这里（ADR-0008）。
 *
 * 有分支时端口字段一律可选——走哪个出口是模型运行时才定的，required 表达不了
 * 「只有被选中那个出口的产物才必须存在」，这一条由产物落盘校验兜底。
 */
function buildOutputSchema(exits: NodeExit[], branching: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (branching) {
    properties.exit = {
      type: "string",
      enum: exits.map((e) => String(e.name)),
      description: "你这次走的出口名",
    };
    required.push("exit");
  }
  for (const exit of exits) {
    for (const port of exit.ports) {
      properties[port.name] = {
        type: "string",
        description: `你写出的「${port.objectTypeName}」产物路径，应为 ${String(port.artifactPath)}`,
      };
      if (!branching) required.push(port.name);
    }
  }
  return { type: "object", additionalProperties: false, properties, required };
}

/**
 * 校验声明的产物真的落盘，并转成下游可读的 PortValue。
 * 模型说写了不算数，文件在不在才算——这是双通道结果唯一的机械兜底。
 */
function collectArtifacts(
  actionName: string,
  outputPorts: readonly ResolvedPort[],
  workspace: RunWorkspace,
): Record<string, PortValue> {
  const outputs: Record<string, PortValue> = {};
  for (const port of outputPorts) {
    const artifactPath = port.artifactPath!;
    const abs = path.join(workspace.workspaceDir, artifactPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(
        `Action「${actionName}」声明的产物没有写出来：${artifactPath}`,
      );
    }
    outputs[port.name] = {
      kind: "file",
      file: {
        path: path.relative(DATA_DIR, abs),
        name: path.basename(artifactPath),
        mime: guessMime(artifactPath),
      },
    };
  }
  return outputs;
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "text/markdown";
  if (ext === ".json") return "application/json";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

function usageRollupKey(runId: string, sessionId: string): string {
  return `${runId}\u0000${sessionId}`;
}

function zeroUsage(): UsageAmounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
}

function readNodeUsage(runId: string, nodeId: string): UsageAmounts {
  return (
    db
      .select({
        inputTokens: runNodes.inputTokens,
        outputTokens: runNodes.outputTokens,
        reasoningTokens: runNodes.reasoningTokens,
        cacheReadTokens: runNodes.cacheReadTokens,
        cacheWriteTokens: runNodes.cacheWriteTokens,
        cost: runNodes.cost,
      })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
      .get() ?? zeroUsage()
  );
}

function readSessionUsage(key: {
  runId: string;
  nodeId: string;
  sessionId: string;
}): { total: UsageAmounts & { chunks: number }; fallbackChunks: number } {
  const persisted = db
    .select({
      inputTokens: sql<number>`coalesce(sum(${nodeUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${nodeUsage.outputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${nodeUsage.reasoningTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${nodeUsage.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(${nodeUsage.cacheWriteTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${nodeUsage.cost}), 0)`,
      chunks: sql<number>`count(*)`,
    })
    .from(nodeUsage)
    .where(
      and(
        eq(nodeUsage.runId, key.runId),
        eq(nodeUsage.nodeId, key.nodeId),
        eq(nodeUsage.sessionId, key.sessionId),
      ),
    )
    .get();
  const fallback = unpersistedUsageForSession(key);
  return {
    total: {
      inputTokens: (persisted?.inputTokens ?? 0) + fallback.inputTokens,
      outputTokens: (persisted?.outputTokens ?? 0) + fallback.outputTokens,
      reasoningTokens: (persisted?.reasoningTokens ?? 0) + fallback.reasoningTokens,
      cacheReadTokens: (persisted?.cacheReadTokens ?? 0) + fallback.cacheReadTokens,
      cacheWriteTokens: (persisted?.cacheWriteTokens ?? 0) + fallback.cacheWriteTokens,
      cost: (persisted?.cost ?? 0) + fallback.cost,
      chunks: (persisted?.chunks ?? 0) + fallback.chunks,
    },
    fallbackChunks: fallback.chunks,
  };
}

function sameUsage(
  left: UsageAmounts & { chunks: number },
  right: UsageAmounts & { chunks: number },
): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.cost === right.cost &&
    left.chunks === right.chunks
  );
}

function usageEventPayload(
  state: UnsettledUsageRollup,
  usage: UsageAmounts,
): Record<string, unknown> {
  return {
    sessionId: state.sessionId,
    model: state.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    detailPersistenceFailures: state.detailPersistenceFailures,
    ...(state.unsettledProcess ? { unsettledProcess: true } : {}),
    costCny: Math.round(usage.cost * 1e6) / 1e6,
  };
}

function refreshUnsettledUsageRollup(state: UnsettledUsageRollup): void {
  const observed = readSessionUsage(state);
  state.detailPersistenceFailures = Math.max(
    state.detailPersistenceFailures,
    observed.fallbackChunks,
  );
  const unchanged = state.lastSession && sameUsage(state.lastSession, observed.total);
  if (!unchanged) {
    db.update(runNodes)
      // 不能用增量叠加：失败明细稍后成功重放时会从内存兜底移到 node_usage。
      // 固定历史基线 + 当前两处事实的并集才能让正常与隔离会话的重试都幂等。
      .set({
        inputTokens: state.base.inputTokens + observed.total.inputTokens,
        outputTokens: state.base.outputTokens + observed.total.outputTokens,
        reasoningTokens: state.base.reasoningTokens + observed.total.reasoningTokens,
        cacheReadTokens: state.base.cacheReadTokens + observed.total.cacheReadTokens,
        cacheWriteTokens: state.base.cacheWriteTokens + observed.total.cacheWriteTokens,
        cost: state.base.cost + observed.total.cost,
        sessionId: state.sessionId,
      })
      .where(and(eq(runNodes.runId, state.runId), eq(runNodes.nodeId, state.nodeId)))
      .run();
    state.lastSession = observed.total;
    state.eventDirty = true;
  }
  if (!state.eventDirty && state.eventId !== undefined) return;
  try {
    const payload = usageEventPayload(state, observed.total);
    if (state.eventId === undefined) {
      const inserted = db
        .insert(runEvents)
        .values({
          runId: state.runId,
          nodeId: state.nodeId,
          ts: new Date(),
          type: "usage",
          payload,
        })
        .returning({ id: runEvents.id })
        .get();
      state.eventId = inserted.id;
    } else {
      db.update(runEvents)
        .set({ payload })
        .where(eq(runEvents.id, state.eventId))
        .run();
    }
    state.eventDirty = false;
  } catch (err) {
    state.eventDirty = true;
    console.error("[engine] 会话用量事件落库失败", state.runId, state.nodeId, err);
  }
}

function usageRollupState(
  ctx: ActionNodeContext,
  sessionId: string,
  model: { modelId: string },
  unsettledProcess: boolean,
): { key: string; state: UnsettledUsageRollup } {
  const key = usageRollupKey(ctx.runId, sessionId);
  const state =
    unsettledUsageRollups.get(key) ??
    ({
      runId: ctx.runId,
      nodeId: ctx.node.id,
      sessionId,
      modelId: model.modelId,
      base: readNodeUsage(ctx.runId, ctx.node.id),
      detailPersistenceFailures: 0,
      eventDirty: true,
      unsettledProcess,
    } satisfies UnsettledUsageRollup);
  if (unsettledProcess) state.unsettledProcess = true;
  unsettledUsageRollups.set(key, state);
  return { key, state };
}

function finishUsageRollup(key: string, state: UnsettledUsageRollup): void {
  refreshUnsettledUsageRollup(state);
  // refresh 对事件写入采取“记录并保留”的策略，不能据此误判整次结算成功。
  // 子进程退出后没有新事件可触发刷新；脏事件必须让 runner 持有运行并继续重试。
  if (state.eventDirty || state.eventId === undefined) {
    throw new Error(`会话 ${state.sessionId} 的用量事件尚未持久化`);
  }
  clearUnpersistedUsageForSession(state);
  unsettledUsageRollups.delete(key);
}

function beginUnsettledUsageRollup(
  ctx: ActionNodeContext,
  sessionId: string,
  model: { modelId: string },
): void {
  const { state } = usageRollupState(ctx, sessionId, model, true);
  refreshUnsettledUsageRollup(state);
}

/** 子进程隔离期间每次事件落库后刷新；非隔离会话只做一次 Map 查询。 */
export function refreshUnsettledActionUsage(runId: string, sessionId: string): void {
  const state = unsettledUsageRollups.get(usageRollupKey(runId, sessionId));
  if (state) refreshUnsettledUsageRollup(state);
}

/** 子进程已确认退出后做最后一次刷新并释放兜底；此后不可能再有迟到 usage。 */
export function finalizeUnsettledActionUsage(runId: string): void {
  const failures: unknown[] = [];
  for (const [key, state] of unsettledUsageRollups) {
    if (state.runId !== runId) continue;
    try {
      finishUsageRollup(key, state);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `运行 ${runId} 的未静止会话用量结算失败`);
  }
}

/**
 * 会话用量以固定节点基线幂等写回 run_nodes，并落一条结算事件。逐条明细（含按每条 usage
 * 到达时刻计的峰谷费用）由 events.ts 在 chunk 到达当下写进 node_usage——
 * 跨过峰谷边界的会话不能整段按收束时刻计价。这里从 node_usage 按会话求和，
 * 再补入明细写入失败时 events.ts 留下的紧凑兜底；兜底只留失败的 usage chunk，
 * 不驻留原始流式事件，也不会在并行运行下把 Next 堆推到 GB 级。
 */
function recordUsage(
  ctx: ActionNodeContext,
  sessionId: string,
  model: { modelId: string },
): void {
  // 正常会话也先登记可重试状态。若 usage 事件瞬时写失败，本次 Action 响亮失败，
  // runner 在子进程退出后沿同一最终结算链持续重试，不能只留下 run_nodes 数字。
  const { key, state } = usageRollupState(ctx, sessionId, model, false);
  finishUsageRollup(key, state);
}
