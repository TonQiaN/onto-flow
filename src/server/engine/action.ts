/**
 * 单个 Action 节点的执行：独立工作区 + opencode 会话 + 输出提取。
 *
 * - 工作区 data/runs/<runId>/<nodeId>/：引用 tools 物化到 .opencode/tools/、
 *   file 输入拷贝到 inputs/。
 * - 工具不设白名单：内置工具全开（与 opencode CLI 行为一致），custom tools
 *   物化到工作区后由 opencode 自动发现启用。
 * - 先 noReply 注入 Rule + Skills 全文，再发正式 prompt（{{端口名}} 插值，
 *   file 输入追加 file:// part）。
 * - 单 text 输出取 parts 文本拼接；多输出或含 json 输出在 prompt 里给出
 *   JSON Schema 要求最终回答输出纯 JSON，解析失败同会话反馈重试。
 *   刻意不用 format/tool_choice——opencode 的 format 靠合成工具 + 强制
 *   tool_choice 实现，DeepSeek 思考模式等 provider 直接 400，prompt 约定
 *   对所有 provider 兼容。
 * - 会话创建前把本次实际使用的完整配置冻结进 run_nodes.snapshot（运行快照），
 *   端口与 prompt/rule/model/skills/tools 一样在**执行时刻**重查，保证快照内部同源同刻。
 */
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  FilePartInput,
  OpencodeClient,
  Part,
  TextPart,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";
import {
  actionPorts,
  actionSkills,
  actionTools,
  actions,
  db,
  models,
  objectTypes,
  runNodes,
  skills,
  tools,
} from "@/db";
import type { ResolvedNode, ResolvedPort } from "@/lib/graph";
import { portValueToPromptText, type PortValue } from "@/lib/values";
import { DATA_DIR, resolveWithinData, safeBasename } from "@/server/fs-safety";
import {
  getLastSessionError,
  getOpencodeClient,
  registerSession,
  releaseSession,
} from "@/server/opencode/server";
// 循环依赖（runner → action → runner）在 ESM 下安全：isRunCancelled 是函数声明，
// 且只在 runActionNode 执行期调用，那时 runner 模块体早已求值完毕。
import { isRunCancelled } from "./runner";

export interface ActionNodeContext {
  runId: string;
  node: ResolvedNode;
  actionId: string;
  inputs: Record<string, PortValue>;
}

/** 运行快照里的端口定义（只留展示所需，不留 id——实体删了也照样读得懂） */
export interface RunSnapshotPort {
  name: string;
  objectTypeName: string;
  kind: "text" | "file" | "json";
}

/** run_nodes.snapshot 的结构：该节点本次执行实际使用的完整配置 */
export interface RunSnapshot {
  actionId: string;
  actionName: string;
  prompt: string;
  rule: string;
  model: { providerId: string; modelId: string; displayName: string };
  reasoningEffort: "low" | "medium" | "high" | "max";
  skills: Array<{ name: string; content: string }>;
  tools: Array<{ name: string; code: string }>;
  ports: { inputs: RunSnapshotPort[]; outputs: RunSnapshotPort[] };
}

export async function runActionNode(
  ctx: ActionNodeContext,
): Promise<Record<string, PortValue>> {
  const action = db
    .select()
    .from(actions)
    .where(eq(actions.id, ctx.actionId))
    .get();
  if (!action) throw new Error("节点引用的 Action 不存在");

  const model = db
    .select()
    .from(models)
    .where(eq(models.id, action.modelId))
    .get();
  if (!model) throw new Error(`Action「${action.name}」引用的模型不存在`);

  const skillRows = db
    .select({ name: skills.name, content: skills.content })
    .from(actionSkills)
    .innerJoin(skills, eq(actionSkills.skillId, skills.id))
    .where(eq(actionSkills.actionId, action.id))
    .orderBy(asc(actionSkills.position))
    .all();

  const toolRows = db
    .select({ name: tools.name, code: tools.code })
    .from(actionTools)
    .innerJoin(tools, eq(actionTools.toolId, tools.id))
    .where(eq(actionTools.actionId, action.id))
    .all();

  // 端口在执行时刻重查：prompt/rule/model/skills/tools 都取自此刻的 Action，端口若还沿用
  // startRun 时刻解析的 ctx.node，运行期间有人改端口就会让快照自相矛盾（见下方一致性校验）。
  const freshPorts = readActionPorts(action.id);

  // ---------- 运行快照 ----------
  // 会话创建前落库：即使随后执行失败（含下面的端口/占位符校验失败），也留下
  // 「那次运行到底跑了什么」的冻结副本。
  // Skill 存全文、Tool 存源码，实体后续被改写/删除都不影响历史可解释性。
  writeSnapshot(ctx, {
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
    tools: toolRows.map((t) => ({ name: t.name, code: t.code })),
    ports: {
      inputs: freshPorts.inputs.map(toSnapshotPort),
      outputs: freshPorts.outputs.map(toSnapshotPort),
    },
  });

  // 执行仍以 ctx.node 为准（连线取值依赖 startRun 时刻解析出的端口），因此两者一旦不一致
  // 就说明 Action 在本次运行途中被改了：宁可终止，也不要拿旧端口跑出与快照对不上的结果。
  assertPortsUnchanged(action.name, ctx.node.inputs, freshPorts.inputs, "输入");
  assertPortsUnchanged(action.name, ctx.node.outputs, freshPorts.outputs, "输出");

  // prompt 里的 {{占位符}} 必须能匹配到输入端口名：匹配不上时插值会静默留下原文，
  // 把 "{{需求文件}}" 这种字面量直接发给模型，白跑一次还拿到答非所问的结果。
  assertPlaceholdersResolvable(action.name, action.prompt, freshPorts.inputs);

  // ---------- 工作区物化 ----------
  const workspace = path.join(DATA_DIR, "runs", ctx.runId, ctx.node.id);
  fs.mkdirSync(workspace, { recursive: true });

  if (toolRows.length > 0) {
    const toolDir = path.join(workspace, ".opencode", "tools");
    fs.mkdirSync(toolDir, { recursive: true });
    for (const tool of toolRows) {
      const safeName = tool.name.replace(/[^\w.-]/g, "_");
      fs.writeFileSync(path.join(toolDir, `${safeName}.ts`), tool.code);
    }
  }

  /** file 输入端口 → 工作区内绝对路径 */
  const filePaths = new Map<string, string>();
  for (const port of ctx.node.inputs) {
    const value = ctx.inputs[port.name];
    if (value?.kind !== "file") continue;
    // 纵深防御：path 约束在 data/ 内、name 只取 basename（runner 已在入口校验，这里再兜底）
    const src = resolveWithinData(value.file.path);
    if (!fs.existsSync(src)) {
      throw new Error(`输入「${port.name}」的文件不存在：${value.file.path}`);
    }
    const inputDir = path.join(workspace, "inputs");
    fs.mkdirSync(inputDir, { recursive: true });
    const dest = path.join(inputDir, safeBasename(value.file.name));
    fs.copyFileSync(src, dest);
    filePaths.set(port.name, dest);
  }

  // ---------- 会话 ----------
  const client = await getOpencodeClient(workspace);
  const created = await client.session.create({
    directory: workspace,
    title: `${action.name} · ${ctx.runId}`,
  });
  if (created.error || !created.data) {
    throw new Error(`创建会话失败：${formatError(created.error)}`);
  }
  const sessionID = created.data.id;
  db.update(runNodes)
    .set({ sessionId: sessionID })
    .where(and(eq(runNodes.runId, ctx.runId), eq(runNodes.nodeId, ctx.node.id)))
    .run();
  registerSession(sessionID, { runId: ctx.runId, nodeId: ctx.node.id }, workspace);

  try {
    // ---------- noReply 注入 Rule + Skills ----------
    const injection = buildInjection(action.rule, skillRows);
    if (injection) {
      const injected = await client.session.prompt({
        sessionID,
        directory: workspace,
        noReply: true,
        parts: [{ type: "text", text: injection }],
      });
      if (injected.error) {
        throw new Error(`注入规则与技能失败：${formatError(injected.error)}`);
      }
    }

    // ---------- 正式 prompt ----------
    const promptText = interpolate(action.prompt, ctx.node.inputs, ctx.inputs);
    const fileParts: Array<TextPartInput | FilePartInput> = [];
    for (const port of ctx.node.inputs) {
      const value = ctx.inputs[port.name];
      const absPath = filePaths.get(port.name);
      if (value?.kind === "file" && absPath) {
        fileParts.push({
          type: "file",
          mime: value.file.mime || "text/plain",
          filename: value.file.name,
          url: `file://${absPath}`,
        });
      }
    }

    const promptBase = {
      sessionID,
      directory: workspace,
      model: { providerID: model.providerId, modelID: model.modelId },
      variant: action.reasoningEffort,
    };

    const outPorts = ctx.node.outputs;
    if (outPorts.length === 0) {
      // 无输出端口：跑完即可
      const res = await client.session.prompt({
        ...promptBase,
        parts: [...fileParts, { type: "text", text: promptText }],
      });
      assertPromptOk(res.error, res.data?.info.error, sessionID);
      return {};
    }

    const singleText = outPorts.length === 1 && outPorts[0].kind !== "json";
    if (singleText) {
      const res = await client.session.prompt({
        ...promptBase,
        parts: [...fileParts, { type: "text", text: promptText }],
      });
      assertPromptOk(res.error, res.data?.info.error, sessionID);
      const text = joinTextParts(res.data?.parts ?? []);
      if (!text.trim()) {
        throw new Error(
          `模型未返回文本输出${sessionErrorSuffix(sessionID)}`,
        );
      }
      return { [outPorts[0].name]: { kind: "text", text } };
    }

    // ---------- 多输出或含 json 输出：prompt 约定纯 JSON（兼容所有 provider） ----------
    const schema = buildOutputSchema(outPorts);
    const structured = await promptStructured(
      client,
      ctx.runId,
      promptBase,
      schema,
      outPorts,
      [...fileParts, { type: "text", text: withJsonContract(promptText, schema) }],
    );
    return extractOutputs(structured, outPorts);
  } finally {
    releaseSession(sessionID);
  }
}

// ---------- helpers ----------

/** 已取消就抛错中止：runner 的 catch 见 isRunCancelled 会记 cancelled 而非 failed */
function assertNotCancelled(runId: string): void {
  if (isRunCancelled(runId)) throw new Error("运行已取消");
}

/** 执行时刻重查该 Action 的端口定义（与 prompt/skills/tools 同一时刻，供快照与校验用） */
function readActionPorts(actionId: string): {
  inputs: ResolvedPort[];
  outputs: ResolvedPort[];
} {
  const rows = db
    .select({
      direction: actionPorts.direction,
      name: actionPorts.name,
      objectTypeId: actionPorts.objectTypeId,
      objectTypeName: objectTypes.name,
      kind: objectTypes.kind,
    })
    .from(actionPorts)
    .innerJoin(objectTypes, eq(actionPorts.objectTypeId, objectTypes.id))
    .where(eq(actionPorts.actionId, actionId))
    .orderBy(asc(actionPorts.position))
    .all();
  const toPort = (row: (typeof rows)[number]): ResolvedPort => ({
    name: row.name,
    objectTypeId: row.objectTypeId,
    objectTypeName: row.objectTypeName,
    kind: row.kind,
  });
  return {
    inputs: rows.filter((r) => r.direction === "input").map(toPort),
    outputs: rows.filter((r) => r.direction === "output").map(toPort),
  };
}

/** startRun 时刻解析的端口 vs 执行时刻重查的端口：不一致说明运行途中 Action 被改了 */
function assertPortsUnchanged(
  actionName: string,
  fromContext: ResolvedPort[],
  fromDb: ResolvedPort[],
  label: string,
): void {
  const fingerprint = (ports: ResolvedPort[]): string =>
    ports.map((p) => `${p.name}:${p.objectTypeId}`).join("|");
  if (fingerprint(fromContext) === fingerprint(fromDb)) return;
  throw new Error(
    `Action「${actionName}」的${label}端口在本次运行期间被修改（运行时为 ${
      fingerprint(fromContext) || "（空）"
    }，当前为 ${fingerprint(fromDb) || "（空）"}），已中止以免产出与快照不符的结果`,
  );
}

/** prompt 里的 {{占位符}} 必须都能匹配到输入端口名，否则原样发给模型 */
function assertPlaceholdersResolvable(
  actionName: string,
  prompt: string,
  inputs: ResolvedPort[],
): void {
  const names = new Set(inputs.map((p) => p.name));
  const unresolved = new Set<string>();
  for (const match of prompt.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = match[1];
    if (!names.has(name)) unresolved.add(name);
  }
  if (unresolved.size === 0) return;
  throw new Error(
    `Action「${actionName}」的 prompt 含无法匹配输入端口的占位符：${[...unresolved]
      .map((n) => `{{${n}}}`)
      .join("、")}（现有输入端口：${
      [...names].join("、") || "无"
    }）`,
  );
}

function toSnapshotPort(port: ResolvedPort): RunSnapshotPort {
  return {
    name: port.name,
    objectTypeName: port.objectTypeName,
    kind: port.kind,
  };
}

function writeSnapshot(ctx: ActionNodeContext, snapshot: RunSnapshot): void {
  db.update(runNodes)
    .set({ snapshot: snapshot as unknown as Record<string, unknown> })
    .where(and(eq(runNodes.runId, ctx.runId), eq(runNodes.nodeId, ctx.node.id)))
    .run();
}

function joinTextParts(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function buildInjection(
  rule: string,
  skillRows: Array<{ name: string; content: string }>,
): string | null {
  const sections: string[] = [];
  if (rule.trim()) sections.push(`## 规则\n\n${rule.trim()}`);
  for (const skill of skillRows) {
    sections.push(`## 技能：${skill.name}\n\n${skill.content}`);
  }
  if (sections.length === 0) return null;
  return `以下规则与技能在执行本次任务时必须遵守/使用：\n\n${sections.join("\n\n")}`;
}

function interpolate(
  prompt: string,
  ports: ResolvedPort[],
  values: Record<string, PortValue>,
): string {
  let text = prompt;
  for (const port of ports) {
    const value = values[port.name];
    if (!value) continue;
    const pattern = new RegExp(
      `\\{\\{\\s*${escapeRegExp(port.name)}\\s*\\}\\}`,
      "g",
    );
    text = text.replace(pattern, portValueToPromptText(value));
  }
  return text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 输出端口 → json_schema：json 端口用自定义 schema，text/file 端口 {type:"string"} */
function buildOutputSchema(ports: ResolvedPort[]): Record<string, unknown> {
  const typeRows = db
    .select()
    .from(objectTypes)
    .where(
      inArray(
        objectTypes.id,
        ports.map((p) => p.objectTypeId),
      ),
    )
    .all();
  const typeById = new Map(typeRows.map((t) => [t.id, t]));

  const properties: Record<string, unknown> = {};
  for (const port of ports) {
    if (port.kind === "json") {
      const custom = typeById.get(port.objectTypeId)?.jsonSchema;
      let parsed: unknown = null;
      if (custom) {
        try {
          parsed = JSON.parse(custom);
        } catch {
          parsed = null;
        }
      }
      properties[port.name] =
        parsed && typeof parsed === "object" ? parsed : { type: "object" };
    } else {
      properties[port.name] = { type: "string" };
    }
  }
  return {
    type: "object",
    properties,
    required: ports.map((p) => p.name),
    additionalProperties: false,
  };
}

/** 给正式 prompt 追加输出契约：最终回答只输出符合 schema 的纯 JSON */
function withJsonContract(
  promptText: string,
  schema: Record<string, unknown>,
): string {
  return [
    promptText,
    "---",
    "## 输出格式要求",
    "完成上述任务后，最终回答只输出一个 JSON 对象——不要解释、不要前后缀（允许 ```json 围栏）。",
    "该 JSON 对象必须符合以下 JSON Schema：",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n\n");
}

/**
 * 多输出/json 输出的取数路径：prompt 约定纯 JSON，解析失败同会话反馈重试（共 3 轮）。
 * 刻意不用 opencode 的 format——它靠「合成工具 + tool_choice:required」实现，
 * DeepSeek 思考模式等 provider 会直接 400；prompt 约定对所有 provider 兼容。
 */
async function promptStructured(
  client: OpencodeClient,
  runId: string,
  promptBase: {
    sessionID: string;
    directory: string;
    model: { providerID: string; modelID: string };
    variant: string;
  },
  schema: Record<string, unknown>,
  ports: ResolvedPort[],
  firstParts: Array<TextPartInput | FilePartInput>,
): Promise<unknown> {
  const required = ports.map((p) => p.name);
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    // 每轮发 prompt 前都查一次：取消可能发生在上一轮 prompt 进行中，
    // 朝已 abort 的会话再发 prompt 会白白计费并让取消迟迟不生效。
    assertNotCancelled(runId);
    const parts: Array<TextPartInput | FilePartInput> =
      attempt === 0
        ? firstParts
        : [
            {
              type: "text",
              text: `上一次输出未能解析（${lastError}）。请重新输出：只输出一个符合先前给出的 JSON Schema 的 JSON 对象，不要输出任何解释或其他文字。`,
            },
          ];
    const res = await client.session.prompt({ ...promptBase, parts });
    if (res.error) {
      lastError = formatError(res.error);
      continue;
    }
    if (res.data?.info.error) {
      lastError = formatError(res.data.info.error);
      continue;
    }
    try {
      const parsed = parseJsonObject(joinTextParts(res.data?.parts ?? []));
      const missing = required.filter((key) => parsed[key] === undefined);
      if (missing.length > 0) {
        throw new Error(`缺少必填键：${missing.join("、")}`);
      }
      return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(
    `结构化输出失败：${lastError}${sessionErrorSuffix(promptBase.sessionID)}`,
  );
}

/**
 * 从模型文本里解析 JSON 对象。内置工具全开后，最终回答前可能夹杂过程性文字，
 * 因此依次尝试：全文 → 最后一个代码围栏内容 → 首尾大括号切片。
 */
function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("模型未返回文本输出");
  const candidates = [trimmed];
  const fences = [...trimmed.matchAll(/```[\w-]*\s*\n([\s\S]*?)\n?```/g)];
  if (fences.length > 0) candidates.push(fences[fences.length - 1][1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 换下一个候选
    }
  }
  throw new Error("输出中没有可解析的 JSON 对象");
}

function extractOutputs(
  structured: unknown,
  ports: ResolvedPort[],
): Record<string, PortValue> {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("结构化输出不是 JSON 对象");
  }
  const record = structured as Record<string, unknown>;
  const outputs: Record<string, PortValue> = {};
  for (const port of ports) {
    const value = record[port.name];
    if (value === undefined) {
      throw new Error(`结构化输出缺少端口「${port.name}」的值`);
    }
    if (port.kind === "json") {
      outputs[port.name] = { kind: "json", json: value };
    } else {
      outputs[port.name] = {
        kind: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      };
    }
  }
  return outputs;
}

function assertPromptOk(
  httpError: unknown,
  infoError: unknown,
  sessionID: string,
): void {
  if (httpError) throw new Error(`模型调用失败：${formatError(httpError)}`);
  if (infoError) {
    throw new Error(`模型返回错误：${formatError(infoError)}`);
  }
  void sessionID;
}

function sessionErrorSuffix(sessionID: string): string {
  const err = getLastSessionError(sessionID);
  return err ? `（会话错误：${formatError(err)}）` : "";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    const text = JSON.stringify(error);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(error);
  }
}
