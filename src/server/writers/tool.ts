import { eq } from "drizzle-orm";
import { db, tools } from "@/db";
import {
  TOOL_PUBLIC_NAME_PATTERN,
  TOOL_RESERVED_PUBLIC_NAME_PREFIX,
  TOOL_RESERVED_PUBLIC_NAMES,
} from "@/server/harness/tool-contract";
import { objectSchemaProblem } from "@/server/harness/tool-schema";
import { recordRevision } from "@/server/revisions";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

/**
 * Tool 是 OntoFlow 契约（ADR-0017）：作者只写模型可见的名字、描述、参数 schema、
 * 可选的输出 schema 与超时，以及一个 execute 模块；cordis 包装归平台。
 */
export interface ToolPayload {
  name: string;
  publicName: string;
  description: string;
  parameters: Record<string, unknown>;
  output: Record<string, unknown> | null;
  timeoutMs: number | null;
  code: string;
}

export type ToolRow = typeof tools.$inferSelect;

/** 上游闭包只准平台包装引用；Tool 里出现它就意味着作者又在写裸插件。 */
const FORBIDDEN_IMPORT = "@deepseek-ai/";

export function parseToolPayload(raw: unknown): WriteResult<ToolPayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  const publicName = typeof body.publicName === "string" ? body.publicName.trim() : "";
  if (!TOOL_PUBLIC_NAME_PATTERN.test(publicName)) {
    return writeFail(
      400,
      `模型可见的工具名「${publicName}」非法：小写字母开头，只含小写字母、数字与下划线，最长 64 位`,
    );
  }
  if (TOOL_RESERVED_PUBLIC_NAMES.has(publicName)) {
    return writeFail(
      400,
      `模型可见的工具名「${publicName}」是上游内建工具或会话数据面工具的名字，契约 Tool 不能占用`,
    );
  }
  if (publicName.startsWith(TOOL_RESERVED_PUBLIC_NAME_PREFIX)) {
    return writeFail(
      400,
      `模型可见的工具名「${publicName}」用了 MCP 工具的前缀 ${TOOL_RESERVED_PUBLIC_NAME_PREFIX}，契约 Tool 不能占用`,
    );
  }

  const parametersProblem = objectSchemaProblem(body.parameters, "parameters");
  if (parametersProblem) return writeFail(400, parametersProblem);
  const parameters = body.parameters as Record<string, unknown>;

  let output: Record<string, unknown> | null = null;
  if (body.output !== undefined && body.output !== null) {
    const outputProblem = objectSchemaProblem(body.output, "output");
    if (outputProblem) return writeFail(400, outputProblem);
    output = body.output as Record<string, unknown>;
  }

  let timeoutMs: number | null = null;
  if (body.timeoutMs !== undefined && body.timeoutMs !== null) {
    if (!Number.isSafeInteger(body.timeoutMs) || (body.timeoutMs as number) <= 0)
      return writeFail(400, "timeoutMs 必须是正整数（毫秒）");
    timeoutMs = body.timeoutMs as number;
  }

  const code = typeof body.code === "string" ? body.code : "";
  if (code.trim() === "") return writeFail(400, "execute 模块源码不能为空");
  if (code.includes(FORBIDDEN_IMPORT)) {
    return writeFail(
      400,
      "execute 模块不能引用 @deepseek-ai/*：Tool 只经 ctx 拿能力，上游 API 由平台包装承接（ADR-0017）",
    );
  }

  return writeOk({
    name,
    publicName,
    description: typeof body.description === "string" ? body.description : "",
    parameters,
    output,
    timeoutMs,
    code,
  });
}

/** 修订 payload：完整契约，回滚原样写回。 */
function revisionPayload(p: ToolPayload): Record<string, unknown> {
  return {
    name: p.name,
    publicName: p.publicName,
    description: p.description,
    parameters: p.parameters,
    output: p.output,
    timeoutMs: p.timeoutMs,
    code: p.code,
  };
}

/** name 与 publicName 的唯一性都交给数据库：UNIQUE 冲突由 handle() 映射成 409。 */
export function createTool(raw: unknown): WriteResult<ToolRow> {
  const parsed = parseToolPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const inserted = tx.insert(tools).values(p).returning().get();
    recordRevision("tool", inserted.id, revisionPayload(p), "", tx);
    return inserted;
  });
  return writeOk(row);
}

/** PUT 与回滚共用的写入路径 */
export function writeTool(id: string, raw: unknown): WriteResult<ToolRow> {
  const existing = db.select().from(tools).where(eq(tools.id, id)).get();
  if (!existing) return writeFail(404, "Tool 不存在");

  const parsed = parseToolPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const updated = tx.update(tools).set(p).where(eq(tools.id, id)).returning().get();
    recordRevision("tool", id, revisionPayload(p), "", tx);
    return updated;
  });
  return writeOk(row);
}
