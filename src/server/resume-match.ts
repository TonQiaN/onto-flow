/** 「简历匹配评分」工作流调用入口的服务层。 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  db,
  objectTypes,
  runNodes,
  runs,
  workflowNodes,
  workflows,
} from "@/db";
import type { ValidationIssue } from "@/lib/graph";
import {
  parseResumeMatchResult,
  RESUME_MATCH_JOB_INPUT_LABEL,
  RESUME_MATCH_OUTPUT_LABEL,
  RESUME_MATCH_RESULT_ARTIFACT,
  RESUME_MATCH_RESULT_SCHEMA_TEXT,
  RESUME_MATCH_RESUME_INPUT_LABEL,
  RESUME_MATCH_WORKFLOW_NAME,
  type ResumeMatchResult,
} from "@/lib/resume-match";
import { isWithinData, resolveWithinData } from "@/server/fs-safety";
import { startRun } from "@/server/engine/runner";
import { resolveWorkflow, type ResolvedWorkflow } from "@/server/resolve";
import {
  type WriteResult,
  writeFail,
  writeOk,
} from "@/server/writers/types";

const MAX_RESULT_BYTES = 1024 * 1024;

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

  const outputs = resolved.nodes.filter((node) => node.kind === "output");
  const outputNode = outputs.find((node) => node.label === RESUME_MATCH_OUTPUT_LABEL);
  if (!outputNode || outputs.length !== 1 || outputNode.inputs.length !== 1) {
    return `简历匹配工作流输出定义不是且仅有「${RESUME_MATCH_OUTPUT_LABEL}」`;
  }
  const outputPort = outputNode.inputs[0];
  const outputType = db
    .select()
    .from(objectTypes)
    .where(eq(objectTypes.id, outputPort.objectTypeId))
    .get();
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
  const inputs = resolved.nodes.filter((node) => node.kind === "input");
  const jobNode = inputs.find((node) => node.label === RESUME_MATCH_JOB_INPUT_LABEL);
  const resumeNode = inputs.find((node) => node.label === RESUME_MATCH_RESUME_INPUT_LABEL);
  // validateWorkflowContract 已证明这两个节点存在；保留显式守卫让类型收窄不靠断言。
  if (!jobNode || !resumeNode) return writeFail(500, "简历匹配工作流输入定义无效");
  const started = await startRun(workflow.id, {
    [jobNode.id]: invocation.job,
    [resumeNode.id]: invocation.resume,
  });
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
  if (!run || run.workflowName !== RESUME_MATCH_WORKFLOW_NAME) {
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

  const outputDefinitions = db
    .select({ id: workflowNodes.id })
    .from(workflowNodes)
    .where(
      and(
        eq(workflowNodes.workflowId, run.workflowId),
        eq(workflowNodes.kind, "output"),
      ),
    )
    .all();
  if (outputDefinitions.length !== 1) {
    return writeFail(500, "成功运行对应的评分输出节点定义已失效");
  }

  // 展示名不是节点身份：Action 也可以叫「评分结果」。先由工作流定义取得唯一
  // output 节点 id，再读这次运行的对应行，避免同名 Action 的 outputs 被误认。
  const outputNode = db
    .select()
    .from(runNodes)
    .where(
      and(
        eq(runNodes.runId, run.id),
        eq(runNodes.nodeId, outputDefinitions[0].id),
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
  return writeOk({ ...base, result: parsed.data });
}
