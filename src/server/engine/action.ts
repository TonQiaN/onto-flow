/**
 * 单个 Action 节点的执行：独立工作区 + opencode 会话 + 输出提取。
 *
 * - 工作区 data/runs/<runId>/<nodeId>/：引用 tools 物化到 .opencode/tools/、
 *   file 输入拷贝到 inputs/。
 * - 先 noReply 注入 Rule + Skills 全文，再发正式 prompt（{{端口名}} 插值，
 *   file 输入追加 file:// part）。
 * - 单 text 输出取 parts 文本拼接；否则 format json_schema 取 info.structured，
 *   deepseek 思考模式 format 失败时降级为同会话普通 prompt 要求纯 JSON。
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

export interface ActionNodeContext {
  runId: string;
  node: ResolvedNode;
  actionId: string;
  inputs: Record<string, PortValue>;
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

  // ---------- 工作区物化 ----------
  const workspace = path.join(DATA_DIR, "runs", ctx.runId, ctx.node.id);
  fs.mkdirSync(workspace, { recursive: true });

  const customToolNames: string[] = [];
  if (toolRows.length > 0) {
    const toolDir = path.join(workspace, ".opencode", "tools");
    fs.mkdirSync(toolDir, { recursive: true });
    for (const tool of toolRows) {
      const safeName = tool.name.replace(/[^\w.-]/g, "_");
      fs.writeFileSync(path.join(toolDir, `${safeName}.ts`), tool.code);
      customToolNames.push(safeName);
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

    // ---------- 工具白名单：所有内置工具显式 false，仅引用的 custom tools true ----------
    const toolIds = await client.tool.ids({ directory: workspace });
    if (toolIds.error) {
      throw new Error(`获取工具列表失败：${formatError(toolIds.error)}`);
    }
    const enabled = new Set(customToolNames);
    const toolsMap: Record<string, boolean> = {};
    for (const id of toolIds.data ?? []) toolsMap[id] = enabled.has(id);
    for (const name of customToolNames) toolsMap[name] = true;

    // ---------- 正式 prompt ----------
    const promptText = interpolate(action.prompt, ctx.node.inputs, ctx.inputs);
    const parts: Array<TextPartInput | FilePartInput> = [];
    for (const port of ctx.node.inputs) {
      const value = ctx.inputs[port.name];
      const absPath = filePaths.get(port.name);
      if (value?.kind === "file" && absPath) {
        parts.push({
          type: "file",
          mime: value.file.mime || "text/plain",
          filename: value.file.name,
          url: `file://${absPath}`,
        });
      }
    }
    parts.push({ type: "text", text: promptText });

    const promptBase = {
      sessionID,
      directory: workspace,
      model: { providerID: model.providerId, modelID: model.modelId },
      variant: action.reasoningEffort,
      tools: toolsMap,
    };

    const outPorts = ctx.node.outputs;
    if (outPorts.length === 0) {
      // 无输出端口：跑完即可
      const res = await client.session.prompt({
        ...promptBase,
        parts,
      });
      assertPromptOk(res.error, res.data?.info.error, sessionID);
      return {};
    }

    const singleText = outPorts.length === 1 && outPorts[0].kind !== "json";
    if (singleText) {
      const res = await client.session.prompt({
        ...promptBase,
        parts,
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

    // ---------- 多输出或含 json 输出：json_schema 结构化 ----------
    const schema = buildOutputSchema(outPorts);
    const res = await client.session.prompt({
      ...promptBase,
      format: { type: "json_schema", schema, retryCount: 1 },
      parts,
    });
    if (res.error) {
      throw new Error(`模型调用失败：${formatError(res.error)}`);
    }
    let structured = res.data?.info.structured;
    if (structured === undefined || structured === null) {
      // deepseek 思考模式不支持 format（session.error 事件 + parts 空）→ 降级
      structured = await fallbackStructured(
        client,
        sessionID,
        workspace,
        promptBase,
        schema,
        outPorts,
      );
    }
    return extractOutputs(structured, outPorts);
  } finally {
    releaseSession(sessionID);
  }
}

// ---------- helpers ----------

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

/** format 失败降级：同会话普通 prompt 要求纯 JSON，剥围栏解析 + 必填键校验，失败重试一次 */
async function fallbackStructured(
  client: OpencodeClient,
  sessionID: string,
  workspace: string,
  promptBase: {
    model: { providerID: string; modelID: string };
    variant: string;
    tools: Record<string, boolean>;
  },
  schema: Record<string, unknown>,
  ports: ResolvedPort[],
): Promise<unknown> {
  const required = ports.map((p) => p.name);
  const ask = [
    "上一步未能产生结构化输出。请现在只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。",
    "该 JSON 对象必须符合以下 JSON Schema：",
    JSON.stringify(schema, null, 2),
  ].join("\n\n");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text =
      attempt === 0
        ? ask
        : `${ask}\n\n上一次输出解析失败（${lastError}），请严格按要求重新输出纯 JSON。`;
    const res = await client.session.prompt({
      sessionID,
      directory: workspace,
      model: promptBase.model,
      variant: promptBase.variant,
      tools: promptBase.tools,
      parts: [{ type: "text", text }],
    });
    if (res.error) {
      lastError = formatError(res.error);
      continue;
    }
    if (res.data?.info.error) {
      lastError = formatError(res.data.info.error);
      continue;
    }
    const raw = joinTextParts(res.data?.parts ?? []);
    try {
      const parsed: unknown = JSON.parse(stripFences(raw));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("结果不是 JSON 对象");
      }
      const missing = required.filter(
        (key) => (parsed as Record<string, unknown>)[key] === undefined,
      );
      if (missing.length > 0) {
        throw new Error(`缺少必填键：${missing.join("、")}`);
      }
      return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(
    `结构化输出降级失败：${lastError}${sessionErrorSuffix(sessionID)}`,
  );
}

function stripFences(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fence) text = fence[1].trim();
  return text;
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
