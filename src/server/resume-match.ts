/** 「简历匹配评分」工作流调用入口的服务层。 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, runNodes, runs, workflowNodes, workflows } from "@/db";
import {
  parseResumeMatchResult,
  RESUME_MATCH_JOB_INPUT_LABEL,
  RESUME_MATCH_OUTPUT_LABEL,
  RESUME_MATCH_RESUME_INPUT_LABEL,
  RESUME_MATCH_WORKFLOW_NAME,
  type ResumeMatchResult,
} from "@/lib/resume-match";
import { isWithinData, resolveWithinData } from "@/server/fs-safety";
import { startRun, type StartRunResult } from "@/server/engine/runner";

const MAX_RESULT_BYTES = 1024 * 1024;

export interface ResumeMatchFileInput {
  kind: "file";
  file: { path: string; name: string; mime: string };
}

export interface ResumeMatchInvocation {
  job: ResumeMatchFileInput;
  resume: ResumeMatchFileInput;
}

export type ParseResumeMatchInvocationResult =
  | { ok: true; data: ResumeMatchInvocation }
  | { ok: false; error: string };

export type StartResumeMatchResult =
  | { ok: true; runId: string }
  | Exclude<StartRunResult, { ok: true }>
  | { ok: false; status: 500; error: string };

export interface ResumeMatchRunView {
  runId: string;
  status: "running" | "success" | "failed" | "cancelled";
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  result: ResumeMatchResult | null;
  historyUrl: string;
}

export type ReadResumeMatchRunResult =
  | { ok: true; data: ResumeMatchRunView }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 500; error: string; issues?: string[] };

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
): ParseResumeMatchInvocationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "请求体必须是 JSON 对象" };
  }
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ["job", "resume"])) {
    return { ok: false, error: "请求体必须且只能包含 job、resume" };
  }
  const job = parseFileInput(body.job, "job");
  if (typeof job === "string") return { ok: false, error: job };
  const resume = parseFileInput(body.resume, "resume");
  if (typeof resume === "string") return { ok: false, error: resume };
  return { ok: true, data: { job, resume } };
}

export async function startResumeMatch(
  invocation: ResumeMatchInvocation,
): Promise<StartResumeMatchResult> {
  const workflow = db
    .select()
    .from(workflows)
    .where(eq(workflows.name, RESUME_MATCH_WORKFLOW_NAME))
    .get();
  if (!workflow) {
    return {
      ok: false,
      status: 500,
      error: `工作流「${RESUME_MATCH_WORKFLOW_NAME}」尚未装入`,
    };
  }
  const inputs = db
    .select()
    .from(workflowNodes)
    .where(
      and(
        eq(workflowNodes.workflowId, workflow.id),
        eq(workflowNodes.kind, "input"),
      ),
    )
    .all();
  const jobNode = inputs.find((node) => node.label === RESUME_MATCH_JOB_INPUT_LABEL);
  const resumeNode = inputs.find((node) => node.label === RESUME_MATCH_RESUME_INPUT_LABEL);
  if (!jobNode || !resumeNode || inputs.length !== 2) {
    return {
      ok: false,
      status: 500,
      error: "简历匹配工作流输入定义不是且仅有岗位JD、简历",
    };
  }
  return startRun(workflow.id, {
    [jobNode.id]: invocation.job,
    [resumeNode.id]: invocation.resume,
  });
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

export function readResumeMatchRun(runId: string): ReadResumeMatchRunResult {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.workflowName !== RESUME_MATCH_WORKFLOW_NAME) {
    return { ok: false, status: 404, error: "简历匹配运行不存在" };
  }
  const base: Omit<ResumeMatchRunView, "result"> = {
    runId: run.id,
    status: run.status,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    historyUrl: `/runs/${run.id}`,
  };
  if (run.status !== "success") return { ok: true, data: { ...base, result: null } };

  const outputNode = db
    .select()
    .from(runNodes)
    .where(
      and(
        eq(runNodes.runId, run.id),
        eq(runNodes.label, RESUME_MATCH_OUTPUT_LABEL),
      ),
    )
    .get();
  const output = outputFile(outputNode?.outputs?.value);
  if (!output) {
    return { ok: false, status: 500, error: "成功运行没有可读取的 JSON 评分结果" };
  }
  const artifact = readResultArtifact(run.runDir, output);
  if (!artifact.ok) return { ok: false, status: 500, error: artifact.error };
  const parsed = parseResumeMatchResult(artifact.content);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 500,
      error: "工作流产出的 JSON 未通过结果契约",
      issues: parsed.errors,
    };
  }
  return { ok: true, data: { ...base, result: parsed.data } };
}
