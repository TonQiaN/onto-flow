import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packChunkRuns,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeSessionSegment,
  parseSessionJsonl,
  projectSession,
  readAgentTrajectory,
} from "./trajectory";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Action 会话轨迹", () => {
  it("解开 packed row，并把初始系统、输入上下文和模型响应投影到三条轨道", () => {
    const chunks = Array.from({ length: 8 }, (_, index) => ({
      type: "assistant/chunk" as const,
      seq: 6 + index,
      time: 120 + index,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta" as const, index: 0, text: String(index) },
      },
    }));
    const packed = packChunkRuns(chunks as SessionEvent[]);
    expect(packed.some((row) => row.type === "text-chunks")).toBe(true);

    const content = jsonl(
      header("node-a", 100, "/Users/example/private/workspace"),
      event("turn/start", 0, 101, { turn: 1 }),
      event("step/start", 1, 102, { turn: 1, step: 1 }),
      event("user/message", 2, 103, userMessage("请检查文件", { kind: "user" })),
      event(
        "user/message",
        3,
        104,
        userMessage("工作区规则", { kind: "agent-instructions", form: "instructions" }),
      ),
      event("request/header", 4, 105, {
        header: {
          config: { provider: "deepseek-official", model: "v4-flash" },
          system: "系统提示",
          tools: [{ name: "read", description: "读取", parameters: { type: "object" } }],
        },
        reason: "initial",
      }),
      event("request/context", 5, 106, {
        provider: "deepseek-official",
        model: "v4-flash",
        contextWindow: 1_000_000,
      }),
      ...packed,
      event("assistant/message", 14, 140, {
        turn: 1,
        step: 1,
        message: assistantMessage([
          { type: "reasoning", text: "先检查" },
          { type: "text", text: "检查完成" },
        ]),
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          reasoningTokens: 2,
          cacheReadTokens: 3,
        },
      }),
      event("step/end", 15, 141, { turn: 1, step: 1 }),
      event("turn/end", 16, 142, { turn: 1, reason: { kind: "completed" } }),
    );

    const parsed = parseSessionJsonl(content);
    expect(parsed.events).toHaveLength(17);
    const session = projectSession(parsed, 1, "/Users/example/private/run");

    expect(session).toMatchObject({
      id: "node-a",
      round: 1,
      status: "completed",
      provider: "deepseek-official",
      model: "v4-flash",
      contextWindow: 1_000_000,
      turns: 1,
      steps: 1,
      calls: 0,
      durationMs: 42,
    });
    expect(session.records[0]).toMatchObject({
      kind: "system",
      lane: "input",
      label: "初始系统提示",
    });
    expect(session.records.map((record) => record.kind)).toEqual([
      "system",
      "user",
      "context",
      "context",
      "assistant",
    ]);
    expect(session.records.some((record) => record.kind === "user")).toBe(true);
    expect(
      session.records.some(
        (record) => record.kind === "context" && record.label === "工作区指令",
      ),
    ).toBe(true);
    const assistant = session.records.find((record) => record.kind === "assistant");
    expect(assistant).toMatchObject({
      lane: "model",
      startedAt: 102,
      finishedAt: 140,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
      },
    });
    expect(assistant?.details.map((detail) => detail.label)).toEqual([
      "推理",
      "回答",
      "用量",
      "时序",
    ]);
    expect(assistant?.details.at(-1)?.content).toContain('"ttftMs": 18');
  });

  it("聚合流中 partial，重试时丢弃旧 attempt 并累计 usage", () => {
    const waiting = projectSession(
      parseSessionJsonl(
        jsonl(
          header("node-waiting", 90),
          event("turn/start", 0, 91, { turn: 1 }),
          event("step/start", 1, 92, { turn: 1, step: 1 }),
        ),
      ),
      1,
      "",
      true,
    );
    expect(waiting.records.find((record) => record.kind === "assistant")).toMatchObject({
      state: "running",
      label: "模型响应中",
      summary: "模型正在响应",
    });

    const prefix = [
      header("node-a", 100),
      event("turn/start", 0, 101, { turn: 1 }),
      event("step/start", 1, 102, { turn: 1, step: 1 }),
      assistantChunk(2, 103, { type: "block-start", index: 0, blockType: "text" }),
      assistantChunk(3, 104, { type: "text-delta", index: 0, text: "旧 attempt" }),
      assistantChunk(4, 105, {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 1, reasoningTokens: 1 },
      }),
      event("llm/retry", 5, 106, {
        retryId: "retry-1",
        turn: 1,
        step: 1,
        provider: "deepseek-official",
        mode: "normal",
        policyKey: "default",
        retry: 1,
        maxRetries: 2,
        delayMs: 50,
        failure: { message: "上游暂时不可用", code: "UPSTREAM" },
      }),
      event("llm/retry-started", 6, 107, {
        retryId: "retry-1",
        turn: 1,
        step: 1,
        retry: 1,
      }),
      assistantChunk(7, 108, { type: "block-start", index: 0, blockType: "text" }),
      assistantChunk(8, 109, { type: "text-delta", index: 0, text: "新 attempt" }),
      assistantChunk(9, 110, {
        type: "usage",
        usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 4 },
      }),
    ];

    const partial = projectSession(parseSessionJsonl(jsonl(...prefix)), 1, "", true);
    const running = partial.records.find((record) => record.kind === "assistant");
    expect(partial.status).toBe("running");
    expect(running).toMatchObject({
      state: "running",
      label: "模型响应中",
      summary: "新 attempt",
      usage: {
        inputTokens: 30,
        outputTokens: 3,
        reasoningTokens: 1,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
      },
    });
    expect(running?.details.find((detail) => detail.label === "回答")?.content).toBe(
      "新 attempt",
    );
    expect(running?.details.map((detail) => detail.content).join("\n")).not.toContain(
      "旧 attempt",
    );
    expect(running?.details.find((detail) => detail.label === "时序")?.content).toContain(
      '"firstTokenAt": 104',
    );
    expect(
      partial.records.find((record) => record.label === "模型请求重试 #1"),
    ).toMatchObject({ state: "error", summary: "上游暂时不可用" });

    const settled = projectSession(
      parseSessionJsonl(
        jsonl(
          ...prefix,
          event("assistant/message", 10, 111, {
            turn: 1,
            step: 1,
            message: assistantMessage([{ type: "text", text: "最终回答" }]),
            // 与第二个 usage chunk 是同一份结算，不能再次相加。
            usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 4 },
          }),
          event("step/end", 11, 112, { turn: 1, step: 1 }),
          event("turn/end", 12, 113, { turn: 1, reason: { kind: "completed" } }),
        ),
      ),
      1,
    );
    const final = settled.records.find((record) => record.kind === "assistant");
    expect(final).toMatchObject({
      state: "complete",
      summary: "最终回答",
      usage: { inputTokens: 30, outputTokens: 3, cacheReadTokens: 4 },
    });
  });

  it("step 关闭无最终消息时投影中断，模型 crash 无 turn/end 时修复会话终态", () => {
    const openEvents = [
      header("node-a", 100),
      event("turn/start", 0, 101, { turn: 1 }),
      event("step/start", 1, 102, { turn: 1, step: 1 }),
      assistantChunk(2, 103, { type: "block-start", index: 0, blockType: "reasoning" }),
      assistantChunk(3, 104, {
        type: "reasoning-delta",
        index: 0,
        text: "尚未完成",
      }),
    ];
    const crashed = projectSession(
      parseSessionJsonl(jsonl(...openEvents)),
      1,
      "",
      false,
    );
    expect(crashed).toMatchObject({
      status: "interrupted",
      finishedAt: 104,
      durationMs: 4,
    });
    expect(crashed.records.find((record) => record.kind === "assistant")).toMatchObject({
      state: "error",
      label: "模型响应中断",
      finishedAt: 104,
    });

    const closed = projectSession(
      parseSessionJsonl(
        jsonl(
          ...openEvents,
          event("step/end", 4, 105, { turn: 1, step: 1 }),
          event("turn/end", 5, 106, { turn: 1, reason: { kind: "completed" } }),
        ),
      ),
      1,
      "",
      true,
    );
    expect(closed.status).toBe("completed");
    expect(closed.records.find((record) => record.kind === "assistant")).toMatchObject({
      state: "error",
      finishedAt: 105,
    });
  });

  it("新回合会重新打开会话，最终状态取最后一回合", () => {
    const content = jsonl(
      header("node-a", 100),
      event("turn/start", 0, 101, { turn: 1 }),
      event("turn/end", 1, 102, { turn: 1, reason: { kind: "completed" } }),
      event("turn/start", 2, 103, { turn: 2 }),
      event("step/start", 3, 104, { turn: 2, step: 1 }),
      assistantChunk(4, 105, { type: "text-delta", index: 0, text: "第二回合" }, 2, 1),
    );

    const session = projectSession(parseSessionJsonl(content), 1, "", false);
    expect(session).toMatchObject({
      status: "interrupted",
      finishedAt: 105,
      durationMs: 5,
      turns: 2,
      steps: 1,
    });
    expect(session.records.find((record) => record.kind === "assistant")).toMatchObject({
      turn: 2,
      state: "error",
      summary: "第二回合",
    });
  });

  it("按 callId 配对乱序的工具调用和结果", () => {
    const content = jsonl(
      header("node-a", 100),
      event("turn/start", 0, 101, { turn: 1 }),
      event("step/start", 1, 102, { turn: 1, step: 1 }),
      event("tool/result", 2, 115, {
        turn: 1,
        step: 1,
        message: toolResultMessage("call-1", "读取完成"),
        meta: { lines: 3 },
      }),
      event("tool/call", 3, 110, {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "read",
        arguments: '{"file_path":"input.md"}',
      }),
      event("step/end", 4, 116, { turn: 1, step: 1 }),
      event("turn/end", 5, 117, { turn: 1, reason: { kind: "completed" } }),
    );

    const session = projectSession(parseSessionJsonl(content), 1);
    expect(session.calls).toBe(1);
    const tool = session.records.find((record) => record.kind === "tool");
    expect(tool).toMatchObject({
      callId: "call-1",
      toolName: "read",
      lane: "tools",
      state: "complete",
      startedAt: 110,
      finishedAt: 115,
    });
    expect(tool?.details.map((detail) => detail.label)).toEqual([
      "参数",
      "结果",
      "展示元数据",
    ]);
    expect(tool?.details[0]).toMatchObject({ format: "json", truncated: false });
  });

  it("工具图片结果保留安全附件元数据，不返回字节或物理路径", () => {
    const content = jsonl(
      header("node-a", 100),
      event("turn/start", 0, 101, { turn: 1 }),
      event("step/start", 1, 102, { turn: 1, step: 1 }),
      event("tool/call", 2, 103, {
        turn: 1,
        step: 1,
        callId: "image-call",
        name: "read_image",
        arguments: '{"path":"resume.png"}',
      }),
      event("tool/result", 3, 104, {
        turn: 1,
        step: 1,
        message: toolResultMessageWithBlocks("image-call", [
          { type: "text", text: "读取完成" },
          {
            type: "image",
            attachment: {
              attachmentId: "sha256:safe",
              mediaType: "image/png",
              bytes: 12,
              width: 2,
              height: 3,
              name: "/Users/private/resume-page.png",
              originalDimensions: { width: 20, height: 30 },
              data: "base64-secret",
              url: "data:image/png;base64,secret",
              path: "/Users/private/raw.png",
            },
          },
        ]),
      }),
      event("step/end", 4, 105, { turn: 1, step: 1 }),
      event("turn/end", 5, 106, { turn: 1, reason: { kind: "completed" } }),
    );

    const session = projectSession(parseSessionJsonl(content), 1);
    const tool = session.records.find((record) => record.kind === "tool");
    expect(tool?.details.find((value) => value.label === "结果")?.content).toContain(
      "[图片]",
    );
    const attachment = tool?.details.find((value) => value.label === "结果附件");
    expect(attachment).toMatchObject({ format: "json", truncated: false });
    expect(JSON.parse(attachment?.content ?? "null")).toEqual([
      {
        attachmentId: "sha256:safe",
        mediaType: "image/png",
        bytes: 12,
        width: 2,
        height: 3,
        name: "resume-page.png",
        originalDimensions: { width: 20, height: 30 },
      },
    ]);
    expect(JSON.stringify(session)).not.toMatch(/base64-secret|data:image|\/Users\/private/);
  });

  it("终态会话把缺失结果的工具标为中断，并用会话 id 稳定区分记录", () => {
    const content = jsonl(
      header("node-a#2", 100),
      event("turn/start", 0, 101, { turn: 1 }),
      event("step/start", 1, 102, { turn: 1, step: 1 }),
      event("tool/call", 2, 103, {
        turn: 1,
        step: 1,
        callId: "same-call-id",
        name: "read",
        arguments: "{}",
      }),
      event("turn/end", 3, 110, {
        turn: 1,
        reason: { kind: "interrupted" },
      }),
    );
    const session = projectSession(parseSessionJsonl(content), 2, "", false);
    const tool = session.records.find((record) => record.kind === "tool");
    expect(tool).toMatchObject({
      id: "node-a#2:tool:same-call-id",
      state: "error",
      summary: "read · 已中断",
      finishedAt: 110,
    });
    expect(tool?.details.at(-1)?.content).toContain("没有记录到对应的工具结果");
  });

  it("按 header id 精确归属节点并按轮次排序", () => {
    const fixture = runFixture();
    writeSession(fixture.runDir, "node-a#2", 200);
    writeSession(fixture.runDir, "node-a", 100);
    writeSession(fixture.runDir, "node-a#bad", 300);
    writeSession(fixture.runDir, "node-ab", 400);

    const result = readAgentTrajectory({
      runDir: fixture.runDir,
      runsRoot: fixture.runsRoot,
      nodeId: "node-a",
      activeSessionId: null,
    });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("测试夹具应有轨迹");
    expect(result.sessions.map((session) => [session.id, session.round])).toEqual([
      ["node-a", 1],
      ["node-a#2", 2],
    ]);
  });

  it("只把 activeSessionId 对应轮次当作活跃，并在全文读取前跳过无关大日志", () => {
    const fixture = runFixture();
    writeSessionContent(
      fixture.runDir,
      "node-a",
      jsonl(header("node-a", 100), event("turn/start", 0, 101, { turn: 1 })),
    );
    writeSessionContent(
      fixture.runDir,
      "node-a#2",
      jsonl(header("node-a#2", 200), event("turn/start", 0, 201, { turn: 1 })),
    );
    const unrelated = sessionLogPath(fixture.runDir, "other-node");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, "x");
    fs.truncateSync(unrelated, 65 * 1024 * 1024);

    const result = readAgentTrajectory({
      runDir: fixture.runDir,
      runsRoot: fixture.runsRoot,
      nodeId: "node-a",
      activeSessionId: "node-a#2",
    });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("测试夹具应有轨迹");
    expect(result.sessions.map(({ id, status, finishedAt }) => ({
      id,
      status,
      finishedAt,
    }))).toEqual([
      { id: "node-a", status: "interrupted", finishedAt: 101 },
      { id: "node-a#2", status: "running", finishedAt: null },
    ]);
  });

  it("cold/live 都忽略未提交尾行，已提交坏行和 seq 缺口报错", () => {
    expect(() => parseSessionJsonl(JSON.stringify(header("node-a", 100)))).toThrow(
      "缺少合法 header",
    );

    const base = jsonl(
      header("node-a", 100),
      event("turn/start", 0, 101, { turn: 1 }),
    );
    const halfTail = `${base}{"type":"assistant/chunk"`;
    expect(parseSessionJsonl(halfTail).events).toHaveLength(1);

    const validButUncommitted = `${base}${JSON.stringify(
      event("turn/end", 1, 102, { turn: 1, reason: { kind: "completed" } }),
    )}`;
    expect(parseSessionJsonl(validButUncommitted).events).toHaveLength(1);

    const badCommitted = `${base}{not-json}\n${JSON.stringify(
      event("turn/end", 1, 102, { turn: 1, reason: { kind: "completed" } }),
    )}\n`;
    expect(() => parseSessionJsonl(badCommitted)).toThrow("第 3 行不是合法 JSON");

    const gap = jsonl(
      header("node-a", 100),
      event("turn/start", 1, 101, { turn: 1 }),
    );
    expect(() => parseSessionJsonl(gap)).toThrow("事件 seq 不连续");

    const futureVersion = jsonl({ ...header("node-a", 100), version: 999 });
    expect(() => parseSessionJsonl(futureVersion)).toThrow("版本不受支持");
    expect(() =>
      parseSessionJsonl(
        jsonl({ type: "session", version: 0, id: "node-a", createdAt: 100 }),
      ),
    ).toThrow("缺少合法 header");
  });

  it("未知 required event 失败关闭，未知 ignorable event 可以跳过", () => {
    const required = jsonl(
      header("node-a", 100),
      { type: "future/required", seq: 0, time: 101, data: {} },
    );
    expect(() => parseSessionJsonl(required)).toThrow("未知 required event");

    const ignorable = jsonl(
      header("node-a", 100),
      { type: "future/informational", seq: 0, time: 101, data: {}, ignorable: true },
      event("turn/start", 1, 102, { turn: 1 }),
    );
    expect(parseSessionJsonl(ignorable).events).toHaveLength(2);

    const knownRequired = jsonl(
      header("node-a", 100),
      event("agent/inbox/spliced", 0, 101, { turn: 1, messages: [] }),
    );
    expect(parseSessionJsonl(knownRequired).events).toHaveLength(1);
  });

  it("限制详情长度并移除工作区和其它本机物理路径", () => {
    const cwd = "/Users/example/private/workspace";
    const content = jsonl(
      header("node-a", 100, cwd),
      event("turn/start", 0, 101, { turn: 1 }),
      event("step/start", 1, 102, { turn: 1, step: 1 }),
      event(
        "user/message",
        2,
        103,
        userMessage(`${cwd}/resume.pdf /tmp/private.txt ${"长".repeat(40_000)}`, {
          kind: "user",
        }),
      ),
    );
    const session = projectSession(parseSessionJsonl(content), 1);
    const user = session.records.find((record) => record.kind === "user");
    const input = user?.details[0];
    expect(input?.truncated).toBe(true);
    expect(input?.content).not.toContain(cwd);
    expect(input?.content).not.toContain("/tmp/private.txt");
    expect(input?.content).toContain("<workspace>");
    expect(user?.summary).not.toContain(cwd);
    expect(user?.summary).not.toContain("/tmp/private.txt");
  });

  it("拒绝 data/runs 之外的存储路径，并区分未记录与已清理", () => {
    const fixture = runFixture();
    expect(() =>
      readAgentTrajectory({
        runDir: path.dirname(fixture.runsRoot),
        runsRoot: fixture.runsRoot,
        nodeId: "node-a",
        activeSessionId: null,
      }),
    ).toThrow("运行目录越界 data/runs");

    const notRecorded = readAgentTrajectory({
      runDir: fixture.runDir,
      runsRoot: fixture.runsRoot,
      nodeId: "node-a",
      activeSessionId: null,
    });
    expect(notRecorded).toEqual({
      available: false,
      reason: "not-recorded",
      sessions: [],
    });

    const cleaned = readAgentTrajectory({
      runDir: path.join(fixture.runsRoot, "missing-run"),
      runsRoot: fixture.runsRoot,
      nodeId: "node-a",
      activeSessionId: null,
    });
    expect(cleaned).toEqual({ available: false, reason: "cleaned", sessions: [] });
  });
});

function runFixture(): { root: string; runsRoot: string; runDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-trajectory-"));
  temporaryRoots.push(root);
  const runsRoot = path.join(root, "runs");
  const runDir = path.join(runsRoot, "run-a");
  fs.mkdirSync(runDir, { recursive: true });
  return { root, runsRoot, runDir };
}

function writeSession(runDir: string, id: string, createdAt: number): void {
  writeSessionContent(
    runDir,
    id,
    jsonl(
      header(id, createdAt, path.join(runDir, "workspace")),
      event("turn/start", 0, createdAt + 1, { turn: 1 }),
      event("turn/end", 1, createdAt + 2, {
        turn: 1,
        reason: { kind: "completed" },
      }),
    ),
  );
}

function writeSessionContent(runDir: string, id: string, content: string): void {
  const logPath = sessionLogPath(runDir, id);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, content);
}

function sessionLogPath(runDir: string, id: string): string {
  return path.join(
    runDir,
    "sessions",
    "encoded-workspace",
    encodeSessionSegment(id),
    "session.jsonl",
  );
}

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function header(id: string, createdAt: number, cwd?: string): Record<string, unknown> {
  return {
    type: "session",
    version: 0,
    id,
    createdAt,
    delegationDepth: 0,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

function event(
  type: string,
  seq: number,
  time: number,
  data: unknown,
): Record<string, unknown> {
  return { type, seq, time, data };
}

function assistantChunk(
  seq: number,
  time: number,
  chunk: Record<string, unknown>,
  turn = 1,
  step = 1,
): Record<string, unknown> {
  return event("assistant/chunk", seq, time, { turn, step, chunk });
}

function userMessage(content: string, source: Record<string, unknown>) {
  return {
    role: "user",
    id: "user-message",
    source,
    content: [{ type: "text", text: content }],
    surfaceOp: "append",
  };
}

function assistantMessage(content: unknown[]) {
  return {
    role: "assistant",
    id: "assistant-message",
    source: { kind: "model", provider: "deepseek-official", model: "v4-flash" },
    content,
  };
}

function toolResultMessage(callId: string, content: string) {
  return toolResultMessageWithBlocks(callId, [{ type: "text", text: content }]);
}

function toolResultMessageWithBlocks(callId: string, content: unknown[]) {
  return {
    role: "user",
    id: "tool-result-message",
    source: { kind: "tool", callId },
    content: [
      {
        type: "tool-result",
        toolCallId: callId,
        content,
        isError: false,
      },
    ],
  };
}
