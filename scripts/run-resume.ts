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

const BASE_URL = (process.env.ONTOFLOW_BASE_URL ?? "http://127.0.0.1:3592").replace(/\/$/, "");
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  error: string | null;
}

/** 轮次行的骨架；输入输出与快照按轮另取（ADR-0018） */
interface RunRound {
  nodeId: string;
  round: number;
  status: "running" | "success" | "failed" | "cancelled" | "skipped";
  sessionId: string | null;
}

interface RunDetail {
  run: {
    id: string;
    workflowId: string;
    status: StatusResponse["status"];
    runDir: string | null;
  };
  nodes: RunNode[];
  rounds: RunRound[];
}

/** 某个节点最后一轮成功的轮次号；没有成功过返回 null */
function lastSuccessfulRound(rounds: RunRound[], nodeId: string): number | null {
  const rows = rounds.filter((row) => row.nodeId === nodeId && row.status === "success");
  return rows.length === 0 ? null : Math.max(...rows.map((row) => row.round));
}

/** 这一轮的产物；输入输出只在轮次行上，经按轮取的那条路由拿（ADR-0018） */
async function roundOutputs(
  runId: string,
  nodeId: string,
  round: number,
): Promise<Record<string, unknown> | null> {
  const payload = await requestJson<{ outputs: Record<string, unknown> | null }>(
    `/api/runs/${runId}/nodes/${nodeId}/rounds/${round}`,
  );
  return payload.outputs;
}

interface HistoryItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: StatusResponse["status"];
  /** 受理来源（服务端从 imports.invocation 读时推导）：这条运行由专用调用入口发起，应为 resume-match-api */
  source: string;
  nodesTotal: number;
  nodesDone: number;
}

/** GET /api/runs 的分页信封（另带 summary，这里用不上） */
interface HistoryEnvelope {
  items: HistoryItem[];
  total: number;
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
  if (!response.ok)
    throw new Error(`${route} 调用失败（HTTP ${response.status}）：${asError(body)}`);
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
  if (value.kind !== "file" || !value.file?.path)
    throw new Error("上传接口没有返回 file PortValue");
  return value;
}

function filePortValue(value: unknown): FilePortValue | null {
  if (typeof value !== "object" || value === null) return null;
  const port = value as Record<string, unknown>;
  if (port.kind !== "file" || typeof port.file !== "object" || port.file === null) return null;
  const file = port.file as Record<string, unknown>;
  return typeof file.path === "string" &&
    typeof file.name === "string" &&
    typeof file.mime === "string"
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
  detail: RunDetail,
): Promise<Array<{ path: string; bytes: number }>> {
  const byPath = new Map<string, FilePortValue>();
  // 产物只在轮次行上：每个节点取它最后一轮成功的那份（ADR-0018）。
  for (const node of detail.nodes) {
    const round = lastSuccessfulRound(detail.rounds, node.nodeId);
    if (round === null) continue;
    for (const value of Object.values((await roundOutputs(runId, node.nodeId, round)) ?? {})) {
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

async function inspectPdfConversions(runId: string, detail: RunDetail) {
  const workspaceDir = detail.run.runDir
    ? path.join(process.cwd(), detail.run.runDir, "workspace")
    : null;
  const pages = [];
  for (const node of detail.nodes) {
    if (node.label !== "岗位JD" && node.label !== "简历") continue;
    const round = lastSuccessfulRound(detail.rounds, node.nodeId);
    if (round === null) continue;
    const input = filePortValue((await roundOutputs(runId, node.nodeId, round))?.value);
    if (!input || input.file.mime.toLowerCase() !== "application/pdf") continue;
    if (!workspaceDir) throw new Error("PDF 运行缺少可检查的工作区路径");
    const expectedPages = readPdfPageCount(resolveWithinData(input.file.path));
    pages.push({ label: node.label, ...inspectPdfPages(workspaceDir, node.nodeId, expectedPages) });
  }
  return pages;
}

async function inspectTrajectories(runId: string, detail: RunDetail) {
  // Action 节点＝有会话的轮次行；输入 / 输出 / 被跳过的节点没有会话（ADR-0018）。
  const withSession = new Set(
    detail.rounds.filter((row) => row.sessionId !== null).map((row) => row.nodeId),
  );
  const actionNodes = detail.nodes.filter((node) => withSession.has(node.nodeId));
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
      throw new Error(
        `Action「${node.label}」没有可检查的 Agent 轨迹：${trajectory.reason ?? "unknown"}`,
      );
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

  const history = await requestJson<HistoryEnvelope>(
    `/api/runs?workflowId=${encodeURIComponent(detail.run.workflowId)}`,
  );
  const historyRow = history.items.find((item) => item.id === started.runId);
  if (!historyRow || historyRow.status !== "success" || historyRow.nodesDone !== 11) {
    throw new Error("运行历史中没有这次已完成运行，或节点进度不完整");
  }
  // 来源是运行列表按入口筛选的依据，专用入口受理的运行必须能被认出来
  if (historyRow.source !== "resume-match-api") {
    throw new Error(`运行历史里的受理来源应为 resume-match-api，实际 ${historyRow.source}`);
  }

  const artifacts = await inspectArtifacts(started.runId, detail);
  if (artifacts.length !== 11) {
    throw new Error(
      `工作区文件应为两份物化输入加九份 Action 产物，共 11 份；实际 ${artifacts.length}`,
    );
  }
  if (!artifacts.some((artifact) => artifact.path.endsWith(`/${RESUME_MATCH_RESULT_ARTIFACT}`))) {
    throw new Error(`工作区缺少 ${RESUME_MATCH_RESULT_ARTIFACT}`);
  }
  const pdfPages = await inspectPdfConversions(started.runId, detail);
  const incompletePdfs = pdfPages.filter((inspection) => !inspection.complete);
  if (incompletePdfs.length > 0) {
    throw new Error(
      `PDF 全页验收未通过：${incompletePdfs
        .map((inspection) => `${inspection.label} 缺第 ${inspection.missingPages.join("/")} 页`)
        .join("；")}`,
    );
  }
  const trajectory = await inspectTrajectories(started.runId, detail);

  const totalTokens = detail.nodes.reduce((sum, node) => sum + totalUsageTokens(node), 0);
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
