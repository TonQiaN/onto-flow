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
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  actionPorts,
  actionSkills,
  actions,
  db,
  models,
  objectTypes,
  runNodes,
  skills,
} from "@/db";
import type { ResolvedNode, ResolvedPort } from "@/lib/graph";
import type { PortValue } from "@/lib/values";
import { DATA_DIR } from "@/server/fs-safety";
import type { RunProcess } from "@/server/harness/runtime";
import type { RunWorkspace } from "@/server/harness/workspace";
import type { NodeSkillRegistration } from "@/server/harness/rpc/types";
import type { EventSinkContext } from "./events";
// 循环依赖（runner → action → runner）在 ESM 下安全：isRunCancelled 是函数声明，
// 且只在 runActionNode 执行期调用，那时 runner 模块体早已求值完毕。
import { isRunCancelled } from "./runner";

export interface ActionNodeContext {
  runId: string;
  node: ResolvedNode;
  actionId: string;
  /** 入端口名 → 上游交来的值（Action 上游是产物引用，输入节点上游是人给的值） */
  inputs: Record<string, PortValue>;
  /** 本次运行独占的 harness 子进程 */
  proc: RunProcess;
  workspace: RunWorkspace;
  /** 会话事件落库上下文表：本节点开跑前把自己登记进去 */
  sinks: Map<string, EventSinkContext>;
}

/** 运行快照里的端口定义（只留展示所需，不留 id——实体删了也照样读得懂） */
export interface RunSnapshotPort {
  name: string;
  objectTypeName: string;
  kind: "text" | "file" | "json";
  /** 输出端口的产物路径（相对工作区） */
  artifactPath?: string;
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

export async function runActionNode(
  ctx: ActionNodeContext,
): Promise<Record<string, PortValue>> {
  assertNotCancelled(ctx.runId);

  const action = db.select().from(actions).where(eq(actions.id, ctx.actionId)).get();
  if (!action) throw new Error(`Action 已不存在：${ctx.actionId}`);
  const model = db.select().from(models).where(eq(models.id, action.modelId)).get();
  if (!model) throw new Error(`Action「${action.name}」引用的模型已不存在`);

  const ports = readActionPorts(ctx.actionId);
  assertPortsUnchanged(ctx.node, ports);

  const skillRows = readActionSkills(ctx.actionId);

  const outputPorts = ports.outputs;
  for (const port of outputPorts) {
    if (!port.artifactPath) {
      throw new Error(
        `Action「${action.name}」的输出端口「${port.name}」没有产物路径；` +
          `内容走工作区文件后每个输出端口都必须声明它写到哪（ADR-0008）`,
      );
    }
  }

  const renderedPrompt = buildPrompt(action.prompt, action.rule, ctx.inputs, ports);

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
      outputs: ports.outputs.map(toSnapshotPort),
    },
    renderedPrompt,
  };
  writeSnapshot(ctx, snapshot);

  // 会话 id 就是节点 id：一个 Action 一轮执行独占一次会话（CONTEXT.md「会话」）。
  const sessionId = ctx.node.id;
  // 登记要先于 runTurn：事件从第一个 chunk 起就会回调过来。
  ctx.sinks.set(sessionId, {
    runId: ctx.runId,
    nodeId: ctx.node.id,
    sessionId,
    providerId: model.providerId,
    modelId: model.modelId,
    reasoningEffort: action.reasoningEffort,
  });
  assertNotCancelled(ctx.runId);

  await ctx.proc.runTurn(
    sessionId,
    [{ type: "text", text: renderedPrompt }],
    {
      agentOptions: { provider: model.providerId, model: model.modelId },
      nodeOptions: {
        outputSchema: buildOutputSchema(outputPorts),
        reasoningEffort: action.reasoningEffort,
        ...(skillRows.length === 0
          ? {}
          : { skills: skillRows.map(toSkillRegistration) }),
      },
      timeoutMs: NODE_TURN_TIMEOUT_MS,
    },
  );

  assertNotCancelled(ctx.runId);
  recordUsage(ctx, sessionId);

  const captured = await ctx.proc.sessionOutput(sessionId);
  if (!captured.captured) {
    throw new Error(
      `Action「${action.name}」没有调用 structured_output 交出结果；` +
        `会话已收束但数据面为空`,
    );
  }

  const outputs = collectArtifacts(action.name, outputPorts, ctx.workspace);
  // 会话用完即关：同一子进程里后续节点各自开自己的会话，互不可见。
  await ctx.proc.closeSession(sessionId);
  return outputs;
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
    a.every((p, i) => p.name === b[i].name && p.objectTypeId === b[i].objectTypeId);
  if (!same(node.inputs, ports.inputs) || !same(node.outputs, ports.outputs)) {
    throw new Error(
      `节点「${node.label}」的端口在运行开始后被改动，本次运行中止：` +
        `运行快照无法解释改动之后产出的结果`,
    );
  }
}

function toSnapshotPort(port: ActionPortRow): RunSnapshotPort {
  return {
    name: port.name,
    objectTypeName: port.objectTypeName,
    kind: port.kind,
    ...(port.artifactPath ? { artifactPath: port.artifactPath } : {}),
  };
}

function toSkillRegistration(
  skill: typeof skills.$inferSelect,
): NodeSkillRegistration {
  return {
    name: skill.name,
    description: skill.description || skill.name,
    content: skill.content,
  };
}

function writeSnapshot(ctx: ActionNodeContext, snapshot: RunSnapshot): void {
  db.update(runNodes)
    .set({ snapshot: snapshot as unknown as Record<string, unknown> })
    .where(and(eq(runNodes.runId, ctx.runId), eq(runNodes.nodeId, ctx.node.id)))
    .run();
}

/**
 * 组装发给模型的完整提示：任务、上游产物指引、必须写出的产物、执行规则。
 * `{{端口名}}` 占位符插值为该入端口的取用说明（文件读路径或字面值）。
 */
function buildPrompt(
  prompt: string,
  rule: string,
  inputs: Record<string, PortValue>,
  ports: { inputs: ActionPortRow[]; outputs: ActionPortRow[] },
): string {
  const sections: string[] = [interpolate(prompt, inputs)];

  if (ports.inputs.length > 0) {
    const lines = ports.inputs.map((port) => {
      const value = inputs[port.name];
      return `- ${port.name}（${port.objectTypeName}）：${describeInput(value)}`;
    });
    sections.push(`## 你要读的东西\n\n${lines.join("\n")}`);
  }

  const outLines = ports.outputs.map(
    (port) => `- \`${port.artifactPath}\`（${port.objectTypeName}）`,
  );
  sections.push(
    `## 你要写的东西\n\n把实质内容写进下面这些文件（路径相对当前目录）：\n\n${outLines.join("\n")}\n\n` +
      `写完后调用 structured_output，每个字段填你实际写出的那个路径。` +
      `不要把长文本塞进 structured_output——它会被完整拼进每个下游节点的提示。`,
  );

  if (rule.trim()) sections.push(`## 执行规则\n\n${rule.trim()}`);
  return sections.join("\n\n");
}

/** 一个入端口的取用说明：文件说路径，字面值直接给。 */
function describeInput(value: PortValue | undefined): string {
  if (!value) return "（上游未提供）";
  switch (value.kind) {
    case "file":
      return `读文件 \`${workspaceRelative(value.file.path)}\``;
    case "text":
      return value.text.length > 200 ? `${value.text.slice(0, 200)}…` : value.text;
    case "json":
      return JSON.stringify(value.json);
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

function interpolate(text: string, inputs: Record<string, PortValue>): string {
  let out = text;
  for (const [name, value] of Object.entries(inputs)) {
    out = out.replace(
      new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, "g"),
      describeInput(value),
    );
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 数据面 schema：每个输出端口一个字段，值是该端口产物的实际路径。
 * 实质内容不进这里（ADR-0008）。
 */
function buildOutputSchema(outputPorts: ActionPortRow[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const port of outputPorts) {
    properties[port.name] = {
      type: "string",
      description: `你写出的「${port.objectTypeName}」产物路径，应为 ${port.artifactPath}`,
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: outputPorts.map((p) => p.name),
  };
}

/**
 * 校验声明的产物真的落盘，并转成下游可读的 PortValue。
 * 模型说写了不算数，文件在不在才算——这是双通道结果唯一的机械兜底。
 */
function collectArtifacts(
  actionName: string,
  outputPorts: ActionPortRow[],
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

/**
 * 会话用量汇总写回 run_nodes。上游每个 step 发一条 usage chunk 且不累积，
 * 直接求和即可——这里没有 opencode 那种同一条消息重复上报的坑。
 */
function recordUsage(ctx: ActionNodeContext, sessionId: string): void {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  for (const event of ctx.proc.eventsOf(sessionId)) {
    const data = (event as { data?: { chunk?: { type?: string; usage?: Record<string, number> } } })
      .data;
    const chunk = data?.chunk;
    if (chunk?.type !== "usage" || !chunk.usage) continue;
    inputTokens += chunk.usage.inputTokens ?? 0;
    outputTokens += chunk.usage.outputTokens ?? 0;
    reasoningTokens += chunk.usage.reasoningTokens ?? 0;
    cacheReadTokens += chunk.usage.cacheReadTokens ?? 0;
  }
  db.update(runNodes)
    .set({ inputTokens, outputTokens, reasoningTokens, cacheReadTokens, sessionId })
    .where(and(eq(runNodes.runId, ctx.runId), eq(runNodes.nodeId, ctx.node.id)))
    .run();
}
