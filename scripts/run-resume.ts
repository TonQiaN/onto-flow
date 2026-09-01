/**
 * 经内部工作流调用入口完整验收一次「简历匹配评分」。
 *
 * 前置：从仓库根运行 npm run dev，再运行：
 *   npx tsx scripts/run-resume.ts [data内岗位路径] [data内简历路径]
 * 已有运行可不花钱复验：npx tsx scripts/run-resume.ts --inspect <runId>
 *
 * 脚本会上传两份文件、调用稳定 API、轮询终态，并核对严格 JSON、运行历史、
 * 十一份工作区文件（两份输入 + 九份 Action 产物）和八个 Action 的 Agent 轨迹。
 * 它只打印脱敏指标，不回显原文。
 */
import fs from "node:fs";
import path from "node:path";
import {
  RESUME_MATCH_RESULT_ARTIFACT,
  RESUME_MATCH_VALIDATOR_TOOL_NAME,
  validateResumeMatchResult,
  type ResumeMatchResult,
} from "../src/lib/resume-match";
import { resolveWithinData } from "../src/server/fs-safety";
import { totalUsageTokens } from "./token-total";
import { isTextPreviewMime } from "./resume-artifact-inspection";
import { inspectPdfPages, readPdfPageCount } from "./resume-pdf-inspection";

const BASE_URL = (process.env.ONTOFLOW_BASE_URL ?? "http://127.0.0.1:3592").replace(
  /\/$/,
  "",
);
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 30 * 60 * 1_000;

interface FilePortValue {
  kind: "file";
  file: { path: string; name: string; mime: string };
}

interface StartedResponse {
  runId: string;
  status: "running";
  statusUrl: string;
  historyUrl: string;
}

interface StatusResponse {
  runId: string;
  status: "running" | "success" | "failed" | "cancelled";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  result: ResumeMatchResult | null;
  historyUrl: string;
}

interface RunNode {
  nodeId: string;
  label: string;
  status: "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";
  snapshot: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  error: string | null;
}

interface RunDetail {
  run: {
    id: string;
    workflowId: string;
    status: StatusResponse["status"];
    runDir: string | null;
  };
  nodes: RunNode[];
}

interface HistoryItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: StatusResponse["status"];
  nodesTotal: number;
  nodesDone: number;
}

interface TrajectoryRecord {
  kind: "system" | "user" | "context" | "assistant" | "tool" | "error";
  state: "complete" | "running" | "error";
  toolName?: string;
  details: Array<{ label: string; content: string; format: "text" | "json" }>;
}

interface TrajectoryResponse {
  available: boolean;
  reason?: string;
  sessions: Array<{
    status: string;
    records: TrajectoryRecord[];
  }>;
}

function asError(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return "响应格式不正确";
}

async function requestJson<T>(route: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${route}`, init);
  } catch (error) {
    throw new Error(
      `无法访问 ${BASE_URL}，请先从仓库根运行 npm run dev：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const content = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch {
    throw new Error(`${route} 返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(`${route} 调用失败（HTTP ${response.status}）：${asError(body)}`);
  return body as T;
}

function mimeOf(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  return "text/plain";
}

async function upload(dataRelativePath: string): Promise<FilePortValue> {
  const absolutePath = resolveWithinData(dataRelativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`输入文件不存在：data/${dataRelativePath}`);
  }
  const name = path.basename(absolutePath);
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(fs.readFileSync(absolutePath))], { type: mimeOf(name) }),
    name,
  );
  const value = await requestJson<FilePortValue>("/api/uploads", {
    method: "POST",
    body: form,
  });
  if (value.kind !== "file" || !value.file?.path) throw new Error("上传接口没有返回 file PortValue");
  return value;
}

function filePortValue(value: unknown): FilePortValue | null {
  if (typeof value !== "object" || value === null) return null;
  const port = value as Record<string, unknown>;
  if (port.kind !== "file" || typeof port.file !== "object" || port.file === null) return null;
  const file = port.file as Record<string, unknown>;
  return typeof file.path === "string" && typeof file.name === "string" && typeof file.mime === "string"
    ? { kind: "file", file: { path: file.path, name: file.name, mime: file.mime } }
    : null;
}

async function waitForTerminal(statusUrl: string): Promise<StatusResponse> {
  const startedAt = Date.now();
  for (;;) {
    const status = await requestJson<StatusResponse>(statusUrl);
    if (status.status !== "running") return status;
    if (Date.now() - startedAt > TIMEOUT_MS) throw new Error("简历匹配运行超过 30 分钟仍未结束");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function inspectArtifacts(
  runId: string,
  nodes: RunNode[],
): Promise<Array<{ path: string; bytes: number }>> {
  const byPath = new Map<string, FilePortValue>();
  for (const node of nodes) {
    for (const value of Object.values(node.outputs ?? {})) {
      const file = filePortValue(value);
      if (file) byPath.set(file.file.path, file);
    }
  }
  const workspaceFiles = [...byPath.values()].filter((value) =>
    value.file.path.includes(`/workspace/`),
  );
  const artifacts: Array<{ path: string; bytes: number }> = [];
  for (const value of workspaceFiles) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolveWithinData(value.file.path));
    } catch {
      throw new Error(`产物不存在：${value.file.name}`);
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`产物不是非空普通文件：${value.file.name}`);
    }
    // files API 是文本预览通道。PDF 等二进制输入只核对本机运行工作区里的
    // 普通文件与非零大小，不能在八个付费会话成功后因 415 被误报成验收失败。
    if (isTextPreviewMime(value.file.mime)) {
      const preview = await requestJson<{ size: number; content: string }>(
        `/api/runs/${runId}/files?path=${encodeURIComponent(value.file.path)}`,
      );
      if (preview.size <= 0 || preview.content.length === 0) {
        throw new Error(`文本产物为空：${value.file.name}`);
      }
    }
    artifacts.push({ path: value.file.path, bytes: stat.size });
  }
  return artifacts;
}

function inspectPdfConversions(detail: RunDetail) {
  const workspaceDir = detail.run.runDir
    ? path.join(process.cwd(), detail.run.runDir, "workspace")
    : null;
  return detail.nodes.flatMap((node) => {
    if (node.label !== "岗位JD" && node.label !== "简历") return [];
    const input = filePortValue(node.outputs?.value);
    if (!input || input.file.mime.toLowerCase() !== "application/pdf") return [];
    if (!workspaceDir) throw new Error("PDF 运行缺少可检查的工作区路径");
    const expectedPages = readPdfPageCount(resolveWithinData(input.file.path));
    return [{ label: node.label, ...inspectPdfPages(workspaceDir, node.nodeId, expectedPages) }];
  });
}

async function inspectTrajectories(runId: string, nodes: RunNode[]) {
  const actionNodes = nodes.filter((node) => node.snapshot !== null);
  if (actionNodes.length !== 8) throw new Error(`Action 节点数应为 8，实际 ${actionNodes.length}`);
  let sessions = 0;
  let records = 0;
  let validatorCalls = 0;
  let validatorPassed = false;
  for (const node of actionNodes) {
    const trajectory = await requestJson<TrajectoryResponse>(
      `/api/runs/${runId}/nodes/${node.nodeId}/trajectory`,
    );
    if (!trajectory.available || trajectory.sessions.length === 0) {
      throw new Error(`Action「${node.label}」没有可检查的 Agent 轨迹：${trajectory.reason ?? "unknown"}`);
    }
    for (const session of trajectory.sessions) {
      sessions++;
      if (session.status !== "completed") {
        throw new Error(`Action「${node.label}」会话状态异常：${session.status}`);
      }
      records += session.records.length;
      if (session.records.some((record) => record.state === "error" || record.kind === "error")) {
        throw new Error(`Action「${node.label}」轨迹中存在错误记录`);
      }
      for (const record of session.records) {
        if (record.toolName !== RESUME_MATCH_VALIDATOR_TOOL_NAME) continue;
        validatorCalls++;
        if (
          record.state === "complete" &&
          record.details.some(
            (detail) => detail.label === "结果" && detail.content.includes('"valid":true'),
          )
        ) {
          validatorPassed = true;
        }
      }
    }
  }
  if (validatorCalls === 0 || !validatorPassed) {
    throw new Error(
      `汇总 Agent 没有留下 ${RESUME_MATCH_VALIDATOR_TOOL_NAME} valid=true 的轨迹证据`,
    );
  }
  return { actionNodes: actionNodes.length, sessions, records, validatorCalls, validatorPassed };
}

async function main(): Promise<void> {
  const inspectOnly = process.argv[2] === "--inspect";
  let started: StartedResponse;
  if (inspectOnly) {
    const runId = process.argv[3];
    if (!runId) throw new Error("--inspect 后必须提供 runId");
    started = {
      runId,
      status: "running",
      statusUrl: `/api/internal/resume-matches/${runId}`,
      historyUrl: `/runs/${runId}`,
    };
    console.log(`复验已有运行：${runId}`);
  } else {
    const jobPath = process.argv[2] ?? path.join("samples", "岗位JD示例.md");
    const resumePath = process.argv[3] ?? path.join("samples", "简历示例.md");
    console.log(`调用入口：${BASE_URL}/api/internal/resume-matches`);
    console.log("上传岗位与简历样例（正文不回显）…");
    const [job, resume] = await Promise.all([upload(jobPath), upload(resumePath)]);
    started = await requestJson<StartedResponse>("/api/internal/resume-matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job, resume }),
    });
    console.log(`运行已启动：${started.runId}`);
  }

  const status = await waitForTerminal(started.statusUrl);
  if (status.status !== "success" || status.result === null) {
    throw new Error(`运行未成功：status=${status.status} error=${status.error ? "yes" : "none"}`);
  }
  const resultErrors = validateResumeMatchResult(status.result);
  if (resultErrors.length > 0) {
    throw new Error(`API 返回结果未通过本地同源校验：${resultErrors.join("；")}`);
  }

  const detail = await requestJson<RunDetail>(`/api/runs/${started.runId}`);
  if (detail.run.status !== "success" || detail.nodes.length !== 11) {
    throw new Error(`运行详情不符合预期：status=${detail.run.status} nodes=${detail.nodes.length}`);
  }
  if (detail.nodes.some((node) => node.status !== "success" || node.error)) {
    throw new Error("运行详情中存在未成功节点");
  }

  const history = await requestJson<HistoryItem[]>(
    `/api/runs?workflowId=${encodeURIComponent(detail.run.workflowId)}`,
  );
  const historyRow = history.find((item) => item.id === started.runId);
  if (!historyRow || historyRow.status !== "success" || historyRow.nodesDone !== 11) {
    throw new Error("运行历史中没有这次已完成运行，或节点进度不完整");
  }

  const artifacts = await inspectArtifacts(started.runId, detail.nodes);
  if (artifacts.length !== 11) {
    throw new Error(`工作区文件应为两份物化输入加九份 Action 产物，共 11 份；实际 ${artifacts.length}`);
  }
  if (!artifacts.some((artifact) => artifact.path.endsWith(`/${RESUME_MATCH_RESULT_ARTIFACT}`))) {
    throw new Error(`工作区缺少 ${RESUME_MATCH_RESULT_ARTIFACT}`);
  }
  const pdfPages = inspectPdfConversions(detail);
  const incompletePdfs = pdfPages.filter((inspection) => !inspection.complete);
  if (incompletePdfs.length > 0) {
    throw new Error(
      `PDF 全页验收未通过：${incompletePdfs
        .map((inspection) => `${inspection.label} 缺第 ${inspection.missingPages.join("/")} 页`)
        .join("；")}`,
    );
  }
  const trajectory = await inspectTrajectories(started.runId, detail.nodes);

  const totalTokens = detail.nodes.reduce(
    (sum, node) => sum + totalUsageTokens(node),
    0,
  );
  const totalCost = detail.nodes.reduce((sum, node) => sum + node.cost, 0);
  console.log(
    JSON.stringify(
      {
        runId: started.runId,
        status: status.status,
        result: {
          schemaVersion: status.result.schemaVersion,
          decision: status.result.decision,
          overallScore: status.result.overallScore,
          matchLevel: status.result.matchLevel,
          contractErrors: resultErrors.length,
        },
        history: {
          visible: true,
          historyUrl: started.historyUrl,
          nodesDone: historyRow.nodesDone,
          nodesTotal: historyRow.nodesTotal,
        },
        nodes: { total: detail.nodes.length, success: detail.nodes.length },
        artifacts: {
          total: artifacts.length,
          nonEmpty: artifacts.every((item) => item.bytes > 0),
        },
        pdfPages,
        trajectory,
        totalTokens,
        totalCostCny: Math.round(totalCost * 1_000_000) / 1_000_000,
      },
      null,
      2,
    ),
  );
}

await main();
