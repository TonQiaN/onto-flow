import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the authenticated recipient console", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);

  assert.match(page, /登录后创建受控消息任务/);
  assert.match(page, /确认发送这条消息/);
  assert.match(page, /"付方圆", "成雨函"/);
  assert.match(page, /不要重复提交/);
  assert.match(layout, /WeLink Message Lab/);
  assert.match(layout, /\/og-v2\.png/);
  assert.match(layout, /summary_large_image/);
});

test("preserves D1 queue safety and private R2 evidence", async () => {
  const [route, migration, hosting] = await Promise.all([
    readFile(new URL("app/api/[[...path]]/route.ts", root), "utf8"),
    readFile(new URL("drizzle/0000_initial.sql", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
  ]);

  assert.match(route, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(route, /WORKER_TOKEN_SHA256/);
  assert.match(route, /const jobId = parts\[1\] === "jobs" \? parts\[2\] : ""/);
  assert.match(route, /const action = parts\[3\]/);
  assert.match(route, /发送结果不确定，已停止自动重试/);
  assert.match(route, /SCREENSHOTS\.put/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.match(migration, /message_jobs_single_active_idx/);
  assert.match(migration, /manual_review/);
  const hostingConfig = JSON.parse(hosting);
  assert.equal(hostingConfig.d1, "DB");
  assert.equal(hostingConfig.r2, "SCREENSHOTS");
  assert.match(hostingConfig.project_id, /^appgprj_/);
});
