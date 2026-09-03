/** 运行历史 API 的总 token 口径必须与详情页一致，且不触碰真实 data/ontoflow.db。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '', error TEXT, run_dir TEXT, imports TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE run_nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL, snapshot TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  inputs TEXT, outputs TEXT, session_id TEXT, error TEXT,
  started_at INTEGER, finished_at INTEGER
);
CREATE TABLE node_usage (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '', variant TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  finish TEXT, ts INTEGER NOT NULL
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { GET } = await import("./route");

interface Envelope {
  items: Array<{ id: string; source: string; totalTokens: number }>;
  total: number;
  page: number;
  pageSize: number;
  summary: {
    runs: number;
    tokens: number;
    cost: number;
    byModel: Array<{ providerId: string; modelId: string; tokens: number; cost: number }>;
  };
}

async function get(search: string): Promise<{ status: number; body: Envelope }> {
  const response = await GET(new Request(`http://localhost/api/runs${search}`));
  return { status: response.status, body: (await response.json()) as Envelope };
}

/**
 * 来源是从 imports.invocation 读时推导的，没有列可以塞——夹具照真实受理那样写 imports。
 * source 传 null 就是「没有 invocation 的运行」，它只可能是画布发起。
 */
const insertRunStmt = sqlite.prepare(
  "INSERT INTO runs (id, workflow_id, status, workflow_name, imports, started_at) VALUES (?, ?, ?, ?, ?, ?)",
);
function insertRun(
  id: string,
  workflowId: string,
  status: string,
  workflowName: string,
  source: string | null,
  startedAt: number,
): void {
  const imports = source === null ? null : JSON.stringify({ invocation: { source } });
  insertRunStmt.run(id, workflowId, status, workflowName, imports, startedAt);
}
const insertUsage = sqlite.prepare(
  "INSERT INTO node_usage (id, run_id, node_id, session_id, message_id, provider_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, ts) VALUES (?, ?, 'node-1', 'node-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

beforeEach(() => {
  sqlite.exec("DELETE FROM node_usage; DELETE FROM run_nodes; DELETE FROM runs;");
  insertRun("run-1", "workflow-1", "success", "测试工作流", "workflow", 1);
  sqlite
    .prepare(
      "INSERT INTO run_nodes (id, run_id, node_id, label, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens) VALUES ('node-row-1', 'run-1', 'node-1', '一', 'success', 10, 20, 7, 3, 4), ('node-row-2', 'run-1', 'node-2', '二', 'success', 1, 2, 50, 0, 0)",
    )
    .run();
});

describe("运行历史 API token 汇总", () => {
  it("跨节点只累计 input/output/cache，reasoning 不重复计数", async () => {
    const { status, body } = await get("");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].totalTokens).toBe(40);
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 30 });
  });
});

/**
 * summary 是「当前筛选范围花了多少钱」的唯一出处，所以它的两条口径都要钉死：
 * 运行数按 distinct 运行算（零用量的运行也算），token / 费用只来自 node_usage 且不因
 * 一次运行有多条明细而翻倍。
 */
describe("运行历史 API 的用量汇总", () => {
  beforeEach(() => {
    // run-1（已有）：两条用量明细，同一模型 —— 验证不重复计数
    insertUsage.run(
      "u1",
      "run-1",
      "turn1-step1",
      "deepseek-official",
      "v4-flash",
      10,
      20,
      7,
      3,
      4,
      0.1,
      1,
    );
    insertUsage.run(
      "u2",
      "run-1",
      "turn1-step2",
      "deepseek-official",
      "v4-flash",
      1,
      2,
      0,
      0,
      0,
      0.02,
      2,
    );
    // run-2：另一条模型路由的一条明细
    insertRun("run-2", "workflow-1", "success", "测试工作流", "resume-match-api", 100);
    insertUsage.run(
      "u3",
      "run-2",
      "turn1-step1",
      "deepseek-official",
      "v4-chat",
      5,
      5,
      0,
      0,
      0,
      0.5,
      101,
    );
    // summary 的 token / 费用与每行同源，都从 run_nodes 求和（node_usage 只供 byModel 拆模型）：
    // 给 run-1 的两个节点行配上与明细一致的费用，给 run-2 补一个节点行。
    sqlite.exec(
      "UPDATE run_nodes SET cost = 0.1 WHERE id = 'node-row-1'; UPDATE run_nodes SET cost = 0.02 WHERE id = 'node-row-2'; " +
        "INSERT INTO run_nodes (id, run_id, node_id, label, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost) VALUES ('node-row-3', 'run-2', 'node-1', '一', 'success', 5, 5, 0, 0, 0, 0.5)",
    );
    // run-3：零用量（免费的输入→输出工作流），必须仍被算进 summary.runs
    // 没有 invocation 的一行：coalesce 让它推导成 workflow
    insertRun("run-3", "workflow-2", "success", "另一个工作流", null, 200);
  });

  it("summary 的 token / 费用从 run_nodes 求和：node_usage 缺一条明细时汇总不掉账", async () => {
    // 模拟 node_usage 插入瞬时失败、只经内存回退折进 run_nodes 的那一 chunk：删掉一条明细
    sqlite.exec("DELETE FROM node_usage WHERE id = 'u2'");
    const { body } = await get("");
    expect(body.summary.tokens).toBe(50);
    expect(body.summary.cost).toBeCloseTo(0.62, 10);
    // byModel 只能按 node_usage 拆，这时略小于 tokens——接口注释说明了这一点
    const byModelTokens = body.summary.byModel.reduce((sum, row) => sum + row.tokens, 0);
    expect(byModelTokens).toBe(47);
  });

  it("runs 数的是筛选集里 distinct 的运行，零用量的运行也算，且多条用量明细不重复计数", async () => {
    const { body } = await get("");
    expect(body.total).toBe(3);
    expect(body.summary.runs).toBe(3);
    // run-1 两条 = (10+20+3+4) + (1+2) = 40；run-2 = 10
    expect(body.summary.tokens).toBe(50);
    expect(body.summary.cost).toBeCloseTo(0.62, 10);
  });

  it("byModel 按路由聚合，无用量的运行不会聚成一个空 provider 行", async () => {
    const { body } = await get("");
    // 费用是 real 求和，逐项 toBeCloseTo；结构与顺序（费用倒序）用 map 比
    expect(
      body.summary.byModel.map(({ providerId, modelId, tokens }) => ({
        providerId,
        modelId,
        tokens,
      })),
    ).toEqual([
      { providerId: "deepseek-official", modelId: "v4-chat", tokens: 10 },
      { providerId: "deepseek-official", modelId: "v4-flash", tokens: 40 },
    ]);
    expect(body.summary.byModel[0].cost).toBeCloseTo(0.5, 10);
    expect(body.summary.byModel[1].cost).toBeCloseTo(0.12, 10);
  });

  it("source 筛选同时收窄 items 与 summary", async () => {
    const { body } = await get("?source=resume-match-api");
    expect(body.items.map((row) => row.id)).toEqual(["run-2"]);
    expect(body.items[0].source).toBe("resume-match-api");
    expect(body.summary).toMatchObject({ runs: 1, tokens: 10, cost: 0.5 });
    expect(body.summary.byModel).toEqual([
      { providerId: "deepseek-official", modelId: "v4-chat", tokens: 10, cost: 0.5 },
    ]);
  });

  it("workflowId 筛选同时收窄 items 与 summary", async () => {
    const { body } = await get("?workflowId=workflow-2");
    expect(body.items.map((row) => row.id)).toEqual(["run-3"]);
    // run-3 零用量：运行数算上它，token 与费用是 0（不是把它从汇总里挤掉）
    expect(body.summary).toMatchObject({ runs: 1, tokens: 0, cost: 0, byModel: [] });
  });

  it("没有 invocation 的运行推导成 workflow，并被 source=workflow 筛进来", async () => {
    expect((await get("?workflowId=workflow-2")).body.items[0].source).toBe("workflow");
    const { body } = await get("?source=workflow");
    // run-1 有 invocation.source=workflow，run-3 根本没有 invocation：两者同归画布发起
    expect(body.items.map((row) => row.id).sort()).toEqual(["run-1", "run-3"]);
    expect(body.summary.runs).toBe(2);
  });

  it("from/to 是左闭右开的 startedAt 窗口", async () => {
    // [100, 200) 只框住 run-2（run-1 在 1、run-3 在 200 恰好落在右开端外）
    const { body } = await get("?from=100&to=200");
    expect(body.items.map((row) => row.id)).toEqual(["run-2"]);
    expect(body.summary).toMatchObject({ runs: 1, tokens: 10 });

    // 右端点包进来才见到 run-3，它零用量但仍计入 runs
    const wider = await get("?from=100&to=201");
    expect(wider.body.items.map((row) => row.id)).toEqual(["run-3", "run-2"]);
    expect(wider.body.summary).toMatchObject({ runs: 2, tokens: 10 });
  });

  it("分页只切 items，summary 仍是整个筛选集", async () => {
    const { body } = await get("?pageSize=1&page=2");
    expect(body.items.map((row) => row.id)).toEqual(["run-2"]);
    expect(body).toMatchObject({ total: 3, page: 2, pageSize: 1 });
    expect(body.summary.runs).toBe(3);
  });

  it("status、source、from、to 的非法取值都是 400", async () => {
    expect((await get("?status=unknown")).status).toBe(400);
    expect((await get("?source=Resume_API")).status).toBe(400);
    expect((await get("?from=昨天")).status).toBe(400);
    expect((await get("?to=1.5")).status).toBe(400);
  });
});
