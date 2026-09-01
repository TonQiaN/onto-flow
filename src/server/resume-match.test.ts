/** 内部简历评分入口测试：输出契约破坏时必须在付费 startRun 前失败。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";
import {
  RESUME_MATCH_JOB_OBJECT_TYPE_NAME,
  RESUME_MATCH_JOB_PARSE_PORT,
  RESUME_MATCH_PARSE_ACTION_NAME,
  RESUME_MATCH_RESULT_ARTIFACT,
  RESUME_MATCH_RESULT_SCHEMA_TEXT,
  RESUME_MATCH_RESUME_OBJECT_TYPE_NAME,
  RESUME_MATCH_RESUME_PARSE_PORT,
  RESUME_MATCH_VALIDATOR_TOOL_NAME,
  type ResumeMatchResult,
} from "../lib/resume-match";
import type { ResolvedActionDefinition, ResolvedWorkflow } from "./resolve";

const controls = vi.hoisted(() => ({
  resolveWorkflow: vi.fn(),
  startResolvedRun: vi.fn(),
  validatorToolCodeIsTrusted: vi.fn(),
}));

vi.mock("@/server/resolve", () => ({ resolveWorkflow: controls.resolveWorkflow }));
vi.mock("@/server/engine/runner", () => ({
  startResolvedRun: controls.startResolvedRun,
}));
vi.mock("@/server/resume-match-validator-integrity", () => ({
  isAuthoritativeResumeMatchValidatorTool: controls.validatorToolCodeIsTrusted,
}));
vi.mock("@/server/fs-safety", () => ({
  isWithinData: () => true,
  resolveWithinData: (value: string) => value,
}));

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE object_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  description TEXT NOT NULL, json_schema TEXT, builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE workflow_nodes (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, kind TEXT NOT NULL,
  action_id TEXT, object_type_id TEXT, label TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0
);
CREATE TABLE tools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
  code TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE action_tools (
  action_id TEXT NOT NULL, tool_id TEXT NOT NULL,
  PRIMARY KEY (action_id, tool_id)
);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY, document TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE revisions (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  version_no INTEGER NOT NULL, payload TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '', error TEXT, run_dir TEXT, imports TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE run_nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  label TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  inputs TEXT, outputs TEXT, session_id TEXT, error TEXT,
  started_at INTEGER, finished_at INTEGER
);
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, node_id TEXT,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { readResumeMatchRun, startResumeMatch } = await import("./resume-match");

const workflowId = "resume-workflow";
const resultTypeId = "resume-result-type";
const jobTypeId = "job-type";
const resumeTypeId = "resume-type";
const parseActionId = "resume-parse-action";
const reportActionId = "resume-report-action";
const validatorToolId = "resume-validator-tool";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-resume-match-"));
const invocation = {
  job: { kind: "file" as const, file: { path: "uploads/job.md", name: "job.md", mime: "text/markdown" } },
  resume: { kind: "file" as const, file: { path: "uploads/resume.md", name: "resume.md", mime: "text/markdown" } },
};
const resumeMatchImports = JSON.stringify({
  invocation: { source: "resume-match-api", contractVersion: 1 },
});

function validResult(): ResumeMatchResult {
  return {
    schemaVersion: "1.0",
    decision: "recommend",
    overallScore: 75,
    matchLevel: "good",
    evidenceConfidence: "low",
    summary: "当前材料支持推荐，匹配结论以现有证据为限。",
    decisiveReasons: ["四个非否决维度达到推荐线，且没有否决项。"],
    veto: { triggered: false, dimensions: [], reasons: [] },
    hardRequirements: [
      {
        requirement: "具备岗位要求的核心技术经验",
        status: "met",
        evidence: "负责核心服务的设计与实现。",
        impact: "硬性条件有直接证据支持。",
      },
    ],
    dimensions: {
      mustHave: {
        reviewerScore: 100,
        finalScore: 100,
        evidenceConfidence: "high",
        conclusion: "全部硬性条件有证据支持。",
      },
      skillMatch: {
        reviewerScore: 80,
        finalScore: 80,
        evidenceConfidence: "high",
        conclusion: "核心技能多数直接命中。",
      },
      experienceDepth: {
        reviewerScore: 70,
        finalScore: 70,
        evidenceConfidence: "medium",
        conclusion: "职责深度达到岗位基本要求。",
      },
      domainFit: {
        reviewerScore: 60,
        finalScore: 60,
        evidenceConfidence: "low",
        conclusion: "存在可迁移经验。",
      },
      stability: {
        reviewerScore: 90,
        finalScore: 90,
        evidenceConfidence: "high",
        conclusion: "时间线完整且自洽。",
      },
      authenticityRisk: {
        reviewerScore: 100,
        finalScore: 100,
        evidenceConfidence: "high",
        conclusion: "未发现足以否决的内部矛盾。",
      },
    },
    strengths: [{ point: "核心技能有项目证据", evidence: "负责核心服务的设计与实现。" }],
    concerns: [
      {
        point: "直接领域经验有限",
        evidenceStatus: "unverified",
        impact: "领域匹配维度按现有证据计分。",
      },
    ],
    adjustments: [],
  };
}

function resolved(
  options: {
    outputLabel?: string;
    artifactPath?: string;
    jobObjectTypeId?: string;
    resumeObjectTypeId?: string;
    jobTargetPort?: string;
    resumeTargetPort?: string;
  } = {},
): ResolvedWorkflow {
  const now = new Date(0);
  const resultRow = sqlite
    .prepare("select json_schema as jsonSchema from object_types where id = ?")
    .get(resultTypeId) as { jsonSchema: string | null };
  const objectTypeRows: ResolvedWorkflow["objectTypes"] = new Map([
    [
      jobTypeId,
      {
        id: jobTypeId,
        name: RESUME_MATCH_JOB_OBJECT_TYPE_NAME,
        kind: "file",
        description: "",
        jsonSchema: null,
        builtin: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      resumeTypeId,
      {
        id: resumeTypeId,
        name: RESUME_MATCH_RESUME_OBJECT_TYPE_NAME,
        kind: "file",
        description: "",
        jsonSchema: null,
        builtin: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    [
      resultTypeId,
      {
        id: resultTypeId,
        name: "评分报告",
        kind: "json",
        description: "",
        jsonSchema: resultRow.jsonSchema,
        builtin: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]);
  const port = (
    name: string,
    kind: "file" | "json",
    objectTypeId: string,
    artifactPath: string | null = null,
  ) => ({
    name,
    kind,
    objectTypeId,
    objectTypeName: objectTypeRows.get(objectTypeId)?.name ?? "未知类型",
    artifactPath,
    exitName: null,
  });
  const parseInputs = [
    port(RESUME_MATCH_JOB_PARSE_PORT, "file", jobTypeId),
    port(RESUME_MATCH_RESUME_PARSE_PORT, "file", resumeTypeId),
  ];
  const reportOutputs = [
    port(
      "结果",
      "json",
      resultTypeId,
      options.artifactPath ?? RESUME_MATCH_RESULT_ARTIFACT,
    ),
  ];
  const definition = (
    actionId: string,
    name: string,
    inputs: ReturnType<typeof port>[],
    outputs: ReturnType<typeof port>[],
  ): ResolvedActionDefinition => ({
    action: {
      id: actionId,
      name,
      description: "",
      prompt: "测试",
      rule: "",
      modelId: "model-test",
      reasoningEffort: "high",
      maxReentries: 0,
      onExhausted: "fail",
      createdAt: now,
      updatedAt: now,
    },
    model: {
      id: "model-test",
      providerId: "deepseek-official",
      modelId: "test-model",
      displayName: "测试模型",
    },
    ports: { inputs, outputs },
    skills: [],
  });
  const validator = sqlite
    .prepare("select id, name, description, code from tools where id = ?")
    .get(validatorToolId) as
    | { id: string; name: string; description: string; code: string }
    | undefined;
  const validatorReferenced = Boolean(
    sqlite
      .prepare("select 1 from action_tools where action_id = ? and tool_id = ?")
      .get(reportActionId, validatorToolId),
  );
  const toolRows = validator && validatorReferenced
    ? [{ ...validator, createdAt: now, updatedAt: now }]
    : [];
  const jobInputType = options.jobObjectTypeId ?? jobTypeId;
  const resumeInputType = options.resumeObjectTypeId ?? resumeTypeId;
  return {
    workflow: {
      id: workflowId,
      name: "简历匹配评分",
      description: "测试",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    nodes: [
      {
        id: "job-input",
        kind: "input",
        label: "岗位JD",
        inputs: [],
        outputs: [port("value", "file", jobInputType)],
      },
      {
        id: "resume-input",
        kind: "input",
        label: "简历",
        inputs: [],
        outputs: [port("value", "file", resumeInputType)],
      },
      {
        id: "parse-action",
        kind: "action",
        label: RESUME_MATCH_PARSE_ACTION_NAME,
        inputs: parseInputs,
        outputs: [],
      },
      {
        id: "report-action",
        kind: "action",
        label: "简历评分·汇总",
        inputs: [],
        outputs: reportOutputs,
      },
      {
        id: "result-output",
        kind: "output",
        label: options.outputLabel ?? "评分结果",
        inputs: [port("value", "json", resultTypeId)],
        outputs: [],
      },
    ],
    edges: [
      {
        id: "job-edge",
        sourceNodeId: "job-input",
        sourcePort: "value",
        targetNodeId: "parse-action",
        targetPort: options.jobTargetPort ?? RESUME_MATCH_JOB_PARSE_PORT,
      },
      {
        id: "resume-edge",
        sourceNodeId: "resume-input",
        sourcePort: "value",
        targetNodeId: "parse-action",
        targetPort: options.resumeTargetPort ?? RESUME_MATCH_RESUME_PARSE_PORT,
      },
      {
        id: "result-edge",
        sourceNodeId: "report-action",
        sourcePort: "结果",
        targetNodeId: "result-output",
        targetPort: "value",
      },
    ],
    nodeRows: new Map([
      [
        "parse-action",
        {
          id: "parse-action",
          workflowId,
          kind: "action" as const,
          actionId: parseActionId,
          objectTypeId: null,
          label: "",
          x: 0,
          y: 0,
        },
      ],
      [
        "report-action",
        {
          id: "report-action",
          workflowId,
          kind: "action" as const,
          actionId: reportActionId,
          objectTypeId: null,
          label: "",
          x: 0,
          y: 0,
        },
      ],
    ]),
    objectTypes: objectTypeRows,
    actionDefinitions: new Map([
      [parseActionId, definition(parseActionId, RESUME_MATCH_PARSE_ACTION_NAME, parseInputs, [])],
      [reportActionId, definition(reportActionId, "简历评分·汇总", [], reportOutputs)],
    ]),
    capabilities: {
      skills: [],
      tools: toolRows,
      toolNamesByActionId: new Map([
        [parseActionId, []],
        [
          reportActionId,
          validator && validatorReferenced ? [RESUME_MATCH_VALIDATOR_TOOL_NAME] : [],
        ],
      ]),
    },
  };
}

beforeEach(() => {
  sqlite.exec(
    "DELETE FROM run_events; DELETE FROM run_nodes; DELETE FROM runs; DELETE FROM revisions; DELETE FROM action_tools; DELETE FROM tools; DELETE FROM settings; DELETE FROM workflow_nodes; DELETE FROM object_types; DELETE FROM workflows;",
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  sqlite
    .prepare(
      "insert into workflows (id, name, description, created_at, updated_at) values (?, ?, '', 0, 0)",
    )
    .run(workflowId, "简历匹配评分");
  sqlite
    .prepare(
      "insert into object_types (id, name, kind, description, json_schema, created_at, updated_at) values (?, ?, 'json', '', ?, 0, 0)",
    )
    .run(resultTypeId, "评分报告", RESUME_MATCH_RESULT_SCHEMA_TEXT);
  sqlite
    .prepare(
      "insert into object_types (id, name, kind, description, json_schema, created_at, updated_at) values (?, ?, 'file', '', NULL, 0, 0)",
    )
    .run(jobTypeId, RESUME_MATCH_JOB_OBJECT_TYPE_NAME);
  sqlite
    .prepare(
      "insert into object_types (id, name, kind, description, json_schema, created_at, updated_at) values (?, ?, 'file', '', NULL, 0, 0)",
    )
    .run(resumeTypeId, RESUME_MATCH_RESUME_OBJECT_TYPE_NAME);
  sqlite
    .prepare(
      "insert into tools (id, name, description, code, created_at, updated_at) values (?, ?, '', 'trusted-validator-code', 0, 0)",
    )
    .run(validatorToolId, RESUME_MATCH_VALIDATOR_TOOL_NAME);
  sqlite
    .prepare("insert into action_tools (action_id, tool_id) values (?, ?)")
    .run(reportActionId, validatorToolId);
  controls.resolveWorkflow.mockReset();
  controls.startResolvedRun.mockReset();
  controls.startResolvedRun.mockResolvedValue({ ok: true, runId: "run-1" });
  controls.validatorToolCodeIsTrusted.mockReset();
  controls.validatorToolCodeIsTrusted.mockImplementation(
    (code: string) => code === "trusted-validator-code",
  );
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  sqlite.close();
});

describe("简历匹配工作流预检", () => {
  it("完整契约通过后把同一图与设置快照交给运行受理", async () => {
    const graph = resolved();
    controls.resolveWorkflow.mockResolvedValue(graph);
    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: true,
      data: { runId: "run-1" },
    });
    expect(controls.resolveWorkflow).toHaveBeenCalledOnce();
    expect(controls.startResolvedRun).toHaveBeenCalledWith(
      graph,
      {
        "job-input": invocation.job,
        "resume-input": invocation.resume,
      },
      expect.objectContaining({ disabledTools: [] }),
      { source: "resume-match-api", contractVersion: 1 },
    );
  });

  it.each([
    ["输出标签", { outputLabel: "旧评分报告" }],
    ["产物路径", { artifactPath: "report.json" }],
  ])("%s 被编辑后在运行受理前失败", async (_name, options) => {
    const graph = resolved(options);
    controls.resolveWorkflow.mockResolvedValue(graph);
    const result = await startResumeMatch(invocation);
    expect(result.ok).toBe(false);
    expect(controls.startResolvedRun).not.toHaveBeenCalled();
  });

  it("岗位与简历对象类型对调时在运行受理前失败", async () => {
    controls.resolveWorkflow.mockResolvedValue(
      resolved({ jobObjectTypeId: resumeTypeId, resumeObjectTypeId: jobTypeId }),
    );

    await expect(startResumeMatch(invocation)).resolves.toMatchObject({
      ok: false,
      status: 500,
    });
    expect(controls.startResolvedRun).not.toHaveBeenCalled();
  });

  it("岗位与简历改接到解析 Action 的相反端口时在运行受理前失败", async () => {
    controls.resolveWorkflow.mockResolvedValue(
      resolved({
        jobTargetPort: RESUME_MATCH_RESUME_PARSE_PORT,
        resumeTargetPort: RESUME_MATCH_JOB_PARSE_PORT,
      }),
    );

    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: false,
      status: 500,
      error: `岗位JD、简历必须分别连接「${RESUME_MATCH_PARSE_ACTION_NAME}」的对应输入端口`,
    });
    expect(controls.startResolvedRun).not.toHaveBeenCalled();
  });

  it("JSON Schema 不兼容时在运行受理前失败", async () => {
    sqlite
      .prepare("update object_types set json_schema = ? where id = ?")
      .run(JSON.stringify({ type: "object" }), resultTypeId);
    controls.resolveWorkflow.mockResolvedValue(resolved());

    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: false,
      status: 500,
      error: "「评分结果」必须使用简历匹配的严格 JSON Schema",
    });
    expect(controls.startResolvedRun).not.toHaveBeenCalled();
  });

  it("汇总 Action 未引用校验 Tool 时在运行受理前失败", async () => {
    sqlite.prepare("delete from action_tools").run();
    controls.resolveWorkflow.mockResolvedValue(resolved());

    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: false,
      status: 500,
      error: `简历匹配汇总 Action 必须引用 ${RESUME_MATCH_VALIDATOR_TOOL_NAME}`,
    });
    expect(controls.startResolvedRun).not.toHaveBeenCalled();
  });

  it("校验 Tool 被全局停用时在运行受理前失败", async () => {
    sqlite
      .prepare("insert into settings (id, document, updated_at) values (1, ?, 0)")
      .run(
        JSON.stringify({
          modelApiKeyEnv: "DEEPSEEK_API_KEY",
          modelBaseUrl: "",
          credentialRefs: [],
          mcpServers: [],
          disabledTools: [RESUME_MATCH_VALIDATOR_TOOL_NAME],
        }),
      );
    controls.resolveWorkflow.mockResolvedValue(resolved());

    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: false,
      status: 500,
      error: `全局设置已停用 ${RESUME_MATCH_VALIDATOR_TOOL_NAME}，不能启动简历匹配运行`,
    });
    expect(controls.startResolvedRun).not.toHaveBeenCalled();
  });

  it("校验 Tool 保留名称但实现被改写时在运行受理前失败", async () => {
    sqlite
      .prepare("update tools set code = ? where id = ?")
      .run("export const valid = true", validatorToolId);
    controls.resolveWorkflow.mockResolvedValue(resolved());

    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: false,
      status: 500,
      error: `校验 Tool ${RESUME_MATCH_VALIDATOR_TOOL_NAME} 的实现与内置版本不一致`,
    });
    expect(controls.startResolvedRun).not.toHaveBeenCalled();
  });

  it("resolve 后共享 Tool 被改写也仍把已预检源码快照交给运行", async () => {
    const graph = resolved();
    controls.resolveWorkflow.mockImplementation(async () => {
      sqlite
        .prepare("update tools set code = ? where id = ?")
        .run("export const forged = true", validatorToolId);
      return graph;
    });

    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: true,
      data: { runId: "run-1" },
    });
    expect(graph.capabilities.tools[0]?.code).toBe("trusted-validator-code");
    expect(controls.startResolvedRun).toHaveBeenCalledWith(
      graph,
      expect.any(Object),
      expect.any(Object),
      { source: "resume-match-api", contractVersion: 1 },
    );
  });
});

describe("简历匹配运行结果", () => {
  it("同名工作流经通用运行入口启动时不属于内部 API", () => {
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, workflow_name, imports, started_at) values ('run-generic', ?, 'running', ?, ?, 100)",
      )
      .run(
        workflowId,
        "简历匹配评分",
        JSON.stringify({ invocation: { source: "workflow" } }),
      );

    expect(readResumeMatchRun("run-generic")).toEqual({
      ok: false,
      status: 404,
      error: "简历匹配运行不存在",
    });
  });

  it("严格 JSON 仍须汇总 Action 留下 validator valid=true 持久回执", () => {
    const result = validResult();
    const resultPath = path.join(tempRoot, RESUME_MATCH_RESULT_ARTIFACT);
    fs.writeFileSync(resultPath, JSON.stringify(result), "utf8");
    sqlite
      .prepare(
        "insert into revisions (id, entity_kind, entity_id, version_no, payload, created_at) values (?, 'workflow', ?, 1, ?, 50)",
      )
      .run(
        "revision-with-validator-node",
        workflowId,
        JSON.stringify({
          nodes: [
            { id: "report-action", kind: "action", label: "简历评分·汇总" },
            { id: "result-output", kind: "output", label: "评分结果" },
          ],
          edges: [
            {
              sourceNodeId: "report-action",
              sourcePort: "结果",
              targetNodeId: "result-output",
              targetPort: "value",
            },
          ],
        }),
      );
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, workflow_name, run_dir, imports, started_at, finished_at) values ('run-1', ?, 'success', ?, ?, ?, 100, 101)",
      )
      .run(workflowId, "简历匹配评分", tempRoot, resumeMatchImports);
    sqlite
      .prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, outputs) values ('report-row', 'run-1', 'report-action', '简历评分·汇总', 'success', '{}')",
      )
      .run();
    sqlite
      .prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, outputs) values ('output-row', 'run-1', 'result-output', '评分结果', 'success', ?)",
      )
      .run(
        JSON.stringify({
          value: {
            kind: "file",
            file: {
              path: resultPath,
              name: RESUME_MATCH_RESULT_ARTIFACT,
              mime: "application/json",
            },
          },
        }),
      );
    sqlite
      .prepare(
        "insert into run_events (run_id, node_id, ts, type, payload) values ('run-1', 'report-action', 100, 'tool', ?)",
      )
      .run(
        JSON.stringify({
          tool: RESUME_MATCH_VALIDATOR_TOOL_NAME,
          status: "ok",
          output: JSON.stringify({ valid: false, errors: ["未通过"] }),
        }),
      );

    expect(readResumeMatchRun("run-1")).toEqual({
      ok: false,
      status: 500,
      error: `成功运行缺少 ${RESUME_MATCH_VALIDATOR_TOOL_NAME} 的 valid=true 持久回执`,
    });

    sqlite
      .prepare(
        "insert into run_events (run_id, node_id, ts, type, payload) values ('run-1', 'report-action', 101, 'tool', ?)",
      )
      .run(
        JSON.stringify({
          tool: RESUME_MATCH_VALIDATOR_TOOL_NAME,
          status: "ok",
          output: JSON.stringify({ valid: true, errors: [] }),
        }),
      );

    expect(readResumeMatchRun("run-1")).toMatchObject({
      ok: true,
      data: { status: "success", result },
    });
  });

  it("按运行时修订的 output 节点 id 读取，不受同名 Action 与当前图改写影响", () => {
    sqlite
      .prepare(
        "insert into revisions (id, entity_kind, entity_id, version_no, payload, created_at) values (?, 'workflow', ?, ?, ?, ?)",
      )
      .run(
        "revision-at-run",
        workflowId,
        1,
        JSON.stringify({
          nodes: [
            { id: "same-label-action", kind: "action", label: "评分结果" },
            { id: "result-output", kind: "output", label: "评分结果" },
          ],
          edges: [
            {
              sourceNodeId: "same-label-action",
              sourcePort: "结果",
              targetNodeId: "result-output",
              targetPort: "value",
            },
          ],
        }),
        50,
      );
    sqlite
      .prepare(
        "insert into revisions (id, entity_kind, entity_id, version_no, payload, created_at) values (?, 'workflow', ?, ?, ?, ?)",
      )
      .run(
        "revision-after-run",
        workflowId,
        2,
        JSON.stringify({
          nodes: [{ id: "replacement-output", kind: "output", label: "评分结果" }],
          edges: [],
        }),
        150,
      );
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, workflow_name, run_dir, imports, started_at, finished_at) values (?, ?, 'success', ?, ?, ?, 100, 101)",
      )
      .run("run-1", workflowId, "简历匹配评分", tempRoot, resumeMatchImports);
    sqlite
      .prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, outputs) values (?, ?, ?, ?, 'success', ?)",
      )
      .run("action-row", "run-1", "same-label-action", "评分结果", JSON.stringify({}));
    sqlite
      .prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, outputs) values (?, ?, ?, ?, 'success', ?)",
      )
      .run(
        "output-row",
        "run-1",
        "result-output",
        "评分结果",
        JSON.stringify({
          value: {
            kind: "file",
            file: {
              path: path.join(tempRoot, "missing-match-result.json"),
              name: "match-result.json",
              mime: "application/json",
            },
          },
        }),
      );

    expect(readResumeMatchRun("run-1")).toEqual({
      ok: false,
      status: 500,
      error: "评分结果文件不存在或不可读",
    });
  });
});
