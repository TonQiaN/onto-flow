/** 「简历匹配评分」工作流调用入口的服务层。 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  runEvents,
  runNodes,
  runs,
  workflows,
} from "@/db";
import type { ValidationIssue } from "@/lib/graph";
import {
  parseResumeMatchResult,
  RESUME_MATCH_JOB_INPUT_LABEL,
  RESUME_MATCH_JOB_OBJECT_TYPE_NAME,
  RESUME_MATCH_JOB_PARSE_PORT,
  RESUME_MATCH_OUTPUT_LABEL,
  RESUME_MATCH_PARSE_ACTION_NAME,
  RESUME_MATCH_RESULT_ARTIFACT,
  RESUME_MATCH_RESULT_SCHEMA_TEXT,
  RESUME_MATCH_RESUME_INPUT_LABEL,
  RESUME_MATCH_RESUME_OBJECT_TYPE_NAME,
  RESUME_MATCH_RESUME_PARSE_PORT,
  RESUME_MATCH_VALIDATOR_TOOL_NAME,
  RESUME_MATCH_WORKFLOW_NAME,
  type ResumeMatchResult,
} from "@/lib/resume-match";
import { isWithinData, resolveWithinData } from "@/server/fs-safety";
import { startResolvedRun } from "@/server/engine/runner";
import { resolveWorkflow, type ResolvedWorkflow } from "@/server/resolve";
import { isAuthoritativeResumeMatchValidatorTool } from "@/server/resume-match-validator-integrity";
import { readSettings, type SettingsDocument } from "@/server/settings";
import {
  type WriteResult,
  writeFail,
  writeOk,
} from "@/server/writers/types";

const MAX_RESULT_BYTES = 1024 * 1024;

interface ResumeMatchResultNodes {
  outputNodeId: string;
  validatorNodeId: string;
}

export interface ResumeMatchFileInput {
  kind: "file";
  file: { path: string; name: string; mime: string };
}

export interface ResumeMatchInvocation {
  job: ResumeMatchFileInput;
  resume: ResumeMatchFileInput;
}

export interface ResumeMatchRunView {
  runId: string;
  status: "running" | "success" | "failed" | "cancelled";
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  result: ResumeMatchResult | null;
  historyUrl: string;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function parseFileInput(value: unknown, label: string): ResumeMatchFileInput | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${label} 必须是上传接口返回的 file PortValue`;
  }
  const port = value as Record<string, unknown>;
  if (!exactKeys(port, ["kind", "file"]) || port.kind !== "file") {
    return `${label} 必须是上传接口返回的 file PortValue`;
  }
  if (typeof port.file !== "object" || port.file === null || Array.isArray(port.file)) {
    return `${label}.file 格式不正确`;
  }
  const file = port.file as Record<string, unknown>;
  if (!exactKeys(file, ["path", "name", "mime"])) {
    return `${label}.file 只能包含 path、name、mime`;
  }
  if (
    typeof file.path !== "string" ||
    file.path.trim() === "" ||
    typeof file.name !== "string" ||
    file.name.trim() === "" ||
    typeof file.mime !== "string" ||
    file.mime.trim() === ""
  ) {
    return `${label}.file 的 path、name、mime 都必须是非空字符串`;
  }
  if (!isWithinData(file.path)) return `${label}.file.path 越界 data/ 目录`;
  return {
    kind: "file",
    file: { path: file.path, name: file.name, mime: file.mime },
  };
}

export function parseResumeMatchInvocation(
  value: unknown,
): WriteResult<ResumeMatchInvocation> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return writeFail(400, "请求体必须是 JSON 对象");
  }
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ["job", "resume"])) {
    return writeFail(400, "请求体必须且只能包含 job、resume");
  }
  const job = parseFileInput(body.job, "job");
  if (typeof job === "string") return writeFail(400, job);
  const resume = parseFileInput(body.resume, "resume");
  if (typeof resume === "string") return writeFail(400, resume);
  return writeOk({ job, resume });
}

/** 对 JSON 对象键排序后比较，Schema 只改缩进或键顺序不应被误判为契约变化。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameResultSchema(schema: string | null): boolean {
  if (!schema) return false;
  try {
    return stableJson(JSON.parse(schema)) === stableJson(JSON.parse(RESUME_MATCH_RESULT_SCHEMA_TEXT));
  } catch {
    return false;
  }
}

/**
 * 内部 API 是付费入口，必须在 startRun 前验证它依赖的完整外部契约。
 * 输入标签、输出标签、JSON Schema 与最终产物路径任一被网页编辑破坏，都直接拒绝。
 */
function validateWorkflowContract(resolved: ResolvedWorkflow): string | null {
  const inputs = resolved.nodes.filter((node) => node.kind === "input");
  const jobNode = inputs.find((node) => node.label === RESUME_MATCH_JOB_INPUT_LABEL);
  const resumeNode = inputs.find((node) => node.label === RESUME_MATCH_RESUME_INPUT_LABEL);
  if (
    !jobNode ||
    !resumeNode ||
    inputs.length !== 2 ||
    jobNode.outputs.length !== 1 ||
    resumeNode.outputs.length !== 1 ||
    jobNode.outputs[0].kind !== "file" ||
    resumeNode.outputs[0].kind !== "file"
  ) {
    return "简历匹配工作流输入定义不是且仅有 file 类型的岗位JD、简历";
  }

  const jobPort = jobNode.outputs[0];
  const resumePort = resumeNode.outputs[0];
  const jobType = resolved.objectTypes.get(jobPort.objectTypeId);
  const resumeType = resolved.objectTypes.get(resumePort.objectTypeId);
  if (
    jobType?.name !== RESUME_MATCH_JOB_OBJECT_TYPE_NAME ||
    resumeType?.name !== RESUME_MATCH_RESUME_OBJECT_TYPE_NAME
  ) {
    return (
      `岗位JD、简历必须分别使用「${RESUME_MATCH_JOB_OBJECT_TYPE_NAME}」与` +
      `「${RESUME_MATCH_RESUME_OBJECT_TYPE_NAME}」对象类型`
    );
  }

  const jobOutgoing = resolved.edges.filter((edge) => edge.sourceNodeId === jobNode.id);
  const resumeOutgoing = resolved.edges.filter((edge) => edge.sourceNodeId === resumeNode.id);
  const jobEdge = jobOutgoing[0];
  const resumeEdge = resumeOutgoing[0];
  const parseNode = jobEdge
    ? resolved.nodes.find((node) => node.id === jobEdge.targetNodeId)
    : undefined;
  const jobTargetPort = parseNode?.inputs.find((port) => port.name === jobEdge?.targetPort);
  const resumeTargetPort = parseNode?.inputs.find((port) => port.name === resumeEdge?.targetPort);
  if (
    jobOutgoing.length !== 1 ||
    resumeOutgoing.length !== 1 ||
    jobEdge?.sourcePort !== "value" ||
    resumeEdge?.sourcePort !== "value" ||
    parseNode?.kind !== "action" ||
    parseNode.label !== RESUME_MATCH_PARSE_ACTION_NAME ||
    resumeEdge?.targetNodeId !== parseNode.id ||
    jobEdge?.targetPort !== RESUME_MATCH_JOB_PARSE_PORT ||
    resumeEdge?.targetPort !== RESUME_MATCH_RESUME_PARSE_PORT ||
    jobTargetPort?.objectTypeId !== jobPort.objectTypeId ||
    resumeTargetPort?.objectTypeId !== resumePort.objectTypeId
  ) {
    return `岗位JD、简历必须分别连接「${RESUME_MATCH_PARSE_ACTION_NAME}」的对应输入端口`;
  }

  const outputs = resolved.nodes.filter((node) => node.kind === "output");
  const outputNode = outputs.find((node) => node.label === RESUME_MATCH_OUTPUT_LABEL);
  if (!outputNode || outputs.length !== 1 || outputNode.inputs.length !== 1) {
    return `简历匹配工作流输出定义不是且仅有「${RESUME_MATCH_OUTPUT_LABEL}」`;
  }
  const outputPort = outputNode.inputs[0];
  const outputType = resolved.objectTypes.get(outputPort.objectTypeId);
  if (
    outputPort.kind !== "json" ||
    !outputType ||
    outputType.kind !== "json" ||
    !sameResultSchema(outputType.jsonSchema)
  ) {
    return `「${RESUME_MATCH_OUTPUT_LABEL}」必须使用简历匹配的严格 JSON Schema`;
  }

  const incoming = resolved.edges.filter((edge) => edge.targetNodeId === outputNode.id);
  if (incoming.length !== 1 || incoming[0].targetPort !== "value") {
    return `「${RESUME_MATCH_OUTPUT_LABEL}」必须且只能连接一个结果产物`;
  }
  const sourceNode = resolved.nodes.find((node) => node.id === incoming[0].sourceNodeId);
  const sourcePort = sourceNode?.outputs.find((port) => port.name === incoming[0].sourcePort);
  if (
    sourceNode?.kind !== "action" ||
    !sourcePort ||
    sourcePort.kind !== "json" ||
    sourcePort.objectTypeId !== outputPort.objectTypeId ||
    sourcePort.artifactPath !== RESUME_MATCH_RESULT_ARTIFACT
  ) {
    return `「${RESUME_MATCH_OUTPUT_LABEL}」的上游 Action 必须产出 ${RESUME_MATCH_RESULT_ARTIFACT}`;
  }
  return null;
}

/** 完整契约通过后，从同一份受理快照取出结果与校验节点身份。 */
function resolvedResultNodes(resolved: ResolvedWorkflow): ResumeMatchResultNodes | null {
  const outputNode = resolved.nodes.find(
    (node) => node.kind === "output" && node.label === RESUME_MATCH_OUTPUT_LABEL,
  );
  const incoming = outputNode
    ? resolved.edges.find(
        (edge) => edge.targetNodeId === outputNode.id && edge.targetPort === "value",
      )
    : undefined;
  return outputNode && incoming
    ? { outputNodeId: outputNode.id, validatorNodeId: incoming.sourceNodeId }
    : null;
}

/** 汇总 Action 必须实际持有校验 Tool，且本次运行快照不能把它全局摘掉。 */
function validateValidatorCapability(
  resolved: ResolvedWorkflow,
  settings: SettingsDocument,
): string | null {
  const outputNode = resolved.nodes.find(
    (node) => node.kind === "output" && node.label === RESUME_MATCH_OUTPUT_LABEL,
  );
  const incoming = outputNode
    ? resolved.edges.find((edge) => edge.targetNodeId === outputNode.id)
    : undefined;
  const actionId = incoming
    ? resolved.nodeRows.get(incoming.sourceNodeId)?.actionId
    : null;
  if (!actionId) {
    return "简历匹配汇总 Action 无法解析校验工具归属";
  }
  const referencedTools = new Set(
    resolved.capabilities.toolNamesByActionId.get(actionId) ?? [],
  );
  const validator = referencedTools.has(RESUME_MATCH_VALIDATOR_TOOL_NAME)
    ? resolved.capabilities.tools.find(
        (tool) => tool.name === RESUME_MATCH_VALIDATOR_TOOL_NAME,
      )
    : undefined;
  if (!validator) {
    return `简历匹配汇总 Action 必须引用 ${RESUME_MATCH_VALIDATOR_TOOL_NAME}`;
  }
  if (!isAuthoritativeResumeMatchValidatorTool(validator.code)) {
    return `校验 Tool ${RESUME_MATCH_VALIDATOR_TOOL_NAME} 的实现与内置版本不一致`;
  }
  if (settings.disabledTools.includes(RESUME_MATCH_VALIDATOR_TOOL_NAME)) {
    return `全局设置已停用 ${RESUME_MATCH_VALIDATOR_TOOL_NAME}，不能启动简历匹配运行`;
  }
  return null;
}

export async function startResumeMatch(
  invocation: ResumeMatchInvocation,
): Promise<WriteResult<{ runId: string }, ValidationIssue>> {
  const workflow = db
    .select()
    .from(workflows)
    .where(eq(workflows.name, RESUME_MATCH_WORKFLOW_NAME))
    .get();
  if (!workflow) {
    return writeFail(500, `工作流「${RESUME_MATCH_WORKFLOW_NAME}」尚未装入`);
  }
  const resolved = await resolveWorkflow(workflow.id);
  if (!resolved) return writeFail(500, "简历匹配工作流无法解析");
  const contractError = validateWorkflowContract(resolved);
  if (contractError) return writeFail(500, contractError);
  const resultNodes = resolvedResultNodes(resolved);
  if (!resultNodes) return writeFail(500, "简历匹配工作流缺少稳定的结果节点身份");
  // 设置与图都只取一次；同一对象交给 startResolvedRun，网页并发保存不能让
  // “预检旧图、付费执行新图”，设置修改也只影响下一次运行。
  const settings = readSettings();
  const capabilityError = validateValidatorCapability(resolved, settings);
  if (capabilityError) return writeFail(500, capabilityError);
  const inputs = resolved.nodes.filter((node) => node.kind === "input");
  const jobNode = inputs.find((node) => node.label === RESUME_MATCH_JOB_INPUT_LABEL);
  const resumeNode = inputs.find((node) => node.label === RESUME_MATCH_RESUME_INPUT_LABEL);
  // validateWorkflowContract 已证明这两个节点存在；保留显式守卫让类型收窄不靠断言。
  if (!jobNode || !resumeNode) return writeFail(500, "简历匹配工作流输入定义无效");
  const started = await startResolvedRun(
    resolved,
    {
      [jobNode.id]: invocation.job,
      [resumeNode.id]: invocation.resume,
    },
    settings,
    { source: "resume-match-api", contractVersion: 1, resultNodes },
    (runId) => captureResumeMatchCompletion(runId, resultNodes),
  );
  if (!started.ok) {
    return started.status === 422
      ? writeFail(started.status, started.error, started.issues)
      : writeFail(started.status, started.error);
  }
  return writeOk({ runId: started.runId });
}

function descendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function outputFile(value: unknown): ResumeMatchFileInput | null {
  const parsed = parseFileInput(value, "result");
  return typeof parsed === "string" ? null : parsed;
}

function validatorReceiptHash(payload: Record<string, unknown> | null): string | null {
  if (
    payload?.tool !== RESUME_MATCH_VALIDATOR_TOOL_NAME ||
    payload.status !== "ok" ||
    typeof payload.output !== "string"
  ) {
    return null;
  }
  try {
    const receipt = JSON.parse(payload.output) as unknown;
    return (
      typeof receipt === "object" &&
      receipt !== null &&
      !Array.isArray(receipt) &&
      exactKeys(receipt as Record<string, unknown>, ["valid", "errors", "resultSha256"]) &&
      (receipt as Record<string, unknown>).valid === true &&
      Array.isArray((receipt as Record<string, unknown>).errors) &&
      ((receipt as Record<string, unknown>).errors as unknown[]).length === 0 &&
      typeof (receipt as Record<string, unknown>).resultSha256 === "string" &&
      /^[0-9a-f]{64}$/.test((receipt as Record<string, unknown>).resultSha256 as string)
    )
      ? ((receipt as Record<string, unknown>).resultSha256 as string)
      : null;
  } catch {
    return null;
  }
}

interface StoredResumeMatchInvocation {
  source: "resume-match-api";
  contractVersion: 1;
  resultNodes: ResumeMatchResultNodes;
}

/** 同名工作流可从通用入口启动；只有专用 POST 原子写下的来源证明可由专用 GET 读取。 */
function resumeMatchInvocation(
  imports: Record<string, unknown> | null,
): StoredResumeMatchInvocation | null {
  if (!imports || typeof imports.invocation !== "object" || imports.invocation === null) {
    return null;
  }
  const invocation = imports.invocation as Record<string, unknown>;
  if (
    invocation.source !== "resume-match-api" ||
    invocation.contractVersion !== 1 ||
    typeof invocation.resultNodes !== "object" ||
    invocation.resultNodes === null ||
    Array.isArray(invocation.resultNodes)
  ) {
    return null;
  }
  const resultNodes = invocation.resultNodes as Record<string, unknown>;
  if (
    !exactKeys(resultNodes, ["outputNodeId", "validatorNodeId"]) ||
    typeof resultNodes.outputNodeId !== "string" ||
    resultNodes.outputNodeId === "" ||
    typeof resultNodes.validatorNodeId !== "string" ||
    resultNodes.validatorNodeId === ""
  ) {
    return null;
  }
  return {
    source: "resume-match-api",
    contractVersion: 1,
    resultNodes: {
      outputNodeId: resultNodes.outputNodeId,
      validatorNodeId: resultNodes.validatorNodeId,
    },
  };
}

/**
 * success 前把事件里的权威 Tool 回执收束成运行元数据。事件写入丢失会让运行失败，
 * 写入成功后事件可按监控保留策略清理，GET 仍由持久完成证据复核精确结果字节。
 */
export function captureResumeMatchCompletion(
  runId: string,
  resultNodes: ResumeMatchResultNodes,
): { ok: true; evidence: Record<string, unknown> } | { ok: false; error: string } {
  const receiptHash = db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        eq(runEvents.nodeId, resultNodes.validatorNodeId),
        eq(runEvents.type, "tool"),
      ),
    )
    .orderBy(desc(runEvents.id))
    .all()
    .map((row) => validatorReceiptHash(row.payload))
    .find((hash): hash is string => hash !== null);
  if (!receiptHash) {
    return {
      ok: false,
      error: `汇总 Action 缺少 ${RESUME_MATCH_VALIDATOR_TOOL_NAME} 的 valid=true 回执`,
    };
  }

  const outputNode = db
    .select()
    .from(runNodes)
    .where(
      and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, resultNodes.outputNodeId),
      ),
    )
    .get();
  const output = outputFile(outputNode?.outputs?.value);
  const run = db.select({ runDir: runs.runDir }).from(runs).where(eq(runs.id, runId)).get();
  if (!output || !run) return { ok: false, error: "运行缺少可读取的 JSON 评分结果" };
  const artifact = readResultArtifact(run.runDir, output);
  if (!artifact.ok) return { ok: false, error: artifact.error };
  const parsed = parseResumeMatchResult(artifact.content);
  if (!parsed.ok) return { ok: false, error: "工作流产出的 JSON 未通过结果契约" };
  const resultSha256 = createHash("sha256").update(artifact.content, "utf8").digest("hex");
  if (resultSha256 !== receiptHash) {
    return { ok: false, error: "评分结果在机械校验后发生了变化" };
  }
  return {
    ok: true,
    evidence: {
      kind: "resume-match",
      contractVersion: 1,
      validatorTool: RESUME_MATCH_VALIDATOR_TOOL_NAME,
      resultSha256,
    },
  };
}

function completionResultHash(imports: Record<string, unknown> | null): string | null {
  if (!imports || typeof imports.completion !== "object" || imports.completion === null) {
    return null;
  }
  const completion = imports.completion as Record<string, unknown>;
  return exactKeys(completion, ["kind", "contractVersion", "validatorTool", "resultSha256"]) &&
    completion.kind === "resume-match" &&
    completion.contractVersion === 1 &&
    completion.validatorTool === RESUME_MATCH_VALIDATOR_TOOL_NAME &&
    typeof completion.resultSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(completion.resultSha256)
    ? completion.resultSha256
    : null;
}

function readResultArtifact(
  runDir: string | null,
  output: ResumeMatchFileInput,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!runDir) return { ok: false, error: "运行没有工作区记录" };
  // runDir 是数据库里的运行时事实；忽略构建期追踪，否则 Turbopack 会把动态路径
  // 扩成整个仓库并把所有文件打进这个 API 路由（与 trajectory.ts 同一处理）。
  const runRoot = path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    runDir,
  );
  const candidate = resolveWithinData(output.file.path);
  if (!descendant(runRoot, candidate)) {
    return { ok: false, error: "评分结果不在该运行目录内" };
  }
  let runReal: string;
  let resultReal: string;
  try {
    runReal = fs.realpathSync.native(runRoot);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile()) return { ok: false, error: "评分结果不是普通文件" };
    if (stat.size > MAX_RESULT_BYTES) {
      return { ok: false, error: "评分结果超过 1 MiB" };
    }
    resultReal = fs.realpathSync.native(candidate);
  } catch {
    return { ok: false, error: "评分结果文件不存在或不可读" };
  }
  if (!descendant(runReal, resultReal)) {
    return { ok: false, error: "评分结果真实路径越界运行目录" };
  }
  return { ok: true, content: fs.readFileSync(resultReal, "utf8") };
}

export function readResumeMatchRun(runId: string): WriteResult<ResumeMatchRunView, string> {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  const invocation = run ? resumeMatchInvocation(run.imports) : null;
  if (
    !run ||
    run.workflowName !== RESUME_MATCH_WORKFLOW_NAME ||
    !invocation
  ) {
    return writeFail(404, "简历匹配运行不存在");
  }
  const base: Omit<ResumeMatchRunView, "result"> = {
    runId: run.id,
    status: run.status,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    historyUrl: `/runs/${run.id}`,
  };
  if (run.status !== "success") return writeOk({ ...base, result: null });

  const resultNodes = invocation.resultNodes;

  // 展示名不是节点身份：Action 也可以叫「评分结果」。节点 id 已在受理时随来源
  // 证明持久化，权威结果只以 (runId, nodeId) 精确读取，不能按 label 或时间猜测。
  const outputNode = db
    .select()
    .from(runNodes)
    .where(
      and(
        eq(runNodes.runId, run.id),
        eq(runNodes.nodeId, resultNodes.outputNodeId),
      ),
    )
    .get();
  const output = outputFile(outputNode?.outputs?.value);
  if (!output) {
    return writeFail(500, "成功运行没有可读取的 JSON 评分结果");
  }
  const artifact = readResultArtifact(run.runDir, output);
  if (!artifact.ok) return writeFail(500, artifact.error);
  const parsed = parseResumeMatchResult(artifact.content);
  if (!parsed.ok) {
    return writeFail(500, "工作流产出的 JSON 未通过结果契约", parsed.errors);
  }
  const completionHash = completionResultHash(run.imports);
  const resultSha256 = createHash("sha256").update(artifact.content, "utf8").digest("hex");
  if (!completionHash || completionHash !== resultSha256) {
    return writeFail(
      500,
      `成功运行缺少 ${RESUME_MATCH_VALIDATOR_TOOL_NAME} 对当前结果的持久完成证据`,
    );
  }
  return writeOk({ ...base, result: parsed.data });
}
