/**
 * 能力端到端冒烟（M3）：验证 Skill 与 Tool 真的进得了运行。
 *
 * - Skill 物化成全局技能库里的目录，运行工作区以 symlink 指过去，
 *   上游 skill-filesystem 从会话 cwd 发现它，模型看描述自行加载。
 * - Tool 是 cordis 插件源码，物化进运行目录并由每运行组合 include，
 *   注册到工具面后模型可调用。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-capabilities.ts
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  actionPorts,
  actionSkills,
  actionTools,
  actions,
  db,
  models,
  objectTypes,
  runEvents,
  runNodes,
  runs,
  skills,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import { startRun } from "../src/server/engine/runner";
import { materializeSkill, skillSlug, SKILL_LIBRARY_DIR } from "../src/server/skill-library";

const PREFIX = "能力冒烟";

const SKILL_CONTENT = `# 三字口令

被要求"报口令"时，口令恒为 **青山不改**。除此之外不要编造别的口令。
`;

const TOOL_CODE = `import type { Context } from "@deepseek-ai/cordis";

export const name = "smoke_stamp";
export const inject = ["tools"];

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: "smoke_stamp",
    description: "把一段文字盖上冒烟印章后返回。要生成印章时必须调用本工具。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string", description: "要盖章的文字" } },
      required: ["text"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { stamped: { type: "string" } },
        required: ["stamped"],
      },
      render: (_args: unknown, value: { stamped: string }) => [{ type: "text", text: value.stamped }],
    },
    execute(args: { text: string }) {
      return Promise.resolve({ stamped: \`【冒烟印章】\${args.text}【印章完】\` });
    },
  });
}
`;

function upsertObjectType(name: string, kind: "text" | "file" | "json"): string {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(objectTypes).values({ id, name, kind, description: "冒烟用" }).run();
  return id;
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");
  const model = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, "deepseek-official"), eq(models.modelId, "deepseek-v4-flash")))
    .get();
  if (!model) throw new Error("找不到模型行");

  // Skill：写库并物化磁盘投影
  const skillName = `${PREFIX}口令`;
  let skill = db.select().from(skills).where(eq(skills.name, skillName)).get();
  if (!skill) {
    const id = crypto.randomUUID();
    db.insert(skills)
      .values({ id, name: skillName, description: "报口令时该用的规则", content: SKILL_CONTENT })
      .run();
    skill = db.select().from(skills).where(eq(skills.id, id)).get()!;
  } else {
    db.update(skills).set({ content: SKILL_CONTENT }).where(eq(skills.id, skill.id)).run();
    skill = db.select().from(skills).where(eq(skills.id, skill.id)).get()!;
  }
  materializeSkill(skill);
  const slug = skillSlug(skill);
  console.log(`技能投影：${path.join(SKILL_LIBRARY_DIR, slug)}/SKILL.md（slug=${slug}）`);

  // Tool
  const toolName = "smoke_stamp";
  let tool = db.select().from(tools).where(eq(tools.name, toolName)).get();
  if (!tool) {
    const id = crypto.randomUUID();
    db.insert(tools).values({ id, name: toolName, description: "盖冒烟印章", code: TOOL_CODE }).run();
    tool = db.select().from(tools).where(eq(tools.id, id)).get()!;
  } else {
    db.update(tools).set({ code: TOOL_CODE }).where(eq(tools.id, tool.id)).run();
  }

  const tIn = upsertObjectType(`${PREFIX}题目`, "text");
  const tOut = upsertObjectType(`${PREFIX}回执`, "file");

  const actionName = `${PREFIX}·报口令`;
  const existing = db.select().from(actions).where(eq(actions.name, actionName)).get();
  const actionId = existing?.id ?? crypto.randomUUID();
  const row = {
    name: actionName,
    description: "冒烟用",
    prompt:
      "先报出口令——口令的规则在你的技能里，先把那个技能加载出来再答，不要凭空猜。" +
      "拿到口令后，调用 smoke_stamp 工具给它盖章，把盖章后的整串写进产物。",
    rule: "口令必须来自技能，印章必须来自工具调用，两样都不许自己编。",
    modelId: model.id,
    reasoningEffort: "low" as const,
    maxReentries: 0,
    onExhausted: "fail" as const,
  };
  if (existing) db.update(actions).set(row).where(eq(actions.id, actionId)).run();
  else db.insert(actions).values({ id: actionId, ...row }).run();
  db.delete(actionPorts).where(eq(actionPorts.actionId, actionId)).run();
  db.insert(actionPorts)
    .values({ actionId, direction: "input", name: "题目", objectTypeId: tIn, position: 0 })
    .run();
  db.insert(actionPorts)
    .values({
      actionId,
      direction: "output",
      name: "回执",
      objectTypeId: tOut,
      artifactPath: "receipt.md",
      position: 0,
    })
    .run();
  db.delete(actionSkills).where(eq(actionSkills.actionId, actionId)).run();
  db.insert(actionSkills).values({ actionId, skillId: skill.id, position: 0 }).run();
  db.delete(actionTools).where(eq(actionTools.actionId, actionId)).run();
  db.insert(actionTools).values({ actionId, toolId: tool!.id }).run();

  const wfName = `${PREFIX}·技能与工具`;
  let wf = db.select().from(workflows).where(eq(workflows.name, wfName)).get();
  if (!wf) {
    const id = crypto.randomUUID();
    db.insert(workflows).values({ id, name: wfName, description: "M3 验收：技能与工具进运行" }).run();
    wf = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
  }
  db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
  db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();
  const nIn = crypto.randomUUID();
  const nA = crypto.randomUUID();
  const nOut = crypto.randomUUID();
  db.insert(workflowNodes)
    .values([
      { id: nIn, workflowId: wf.id, kind: "input", objectTypeId: tIn, label: "题目", x: 0, y: 0 },
      { id: nA, workflowId: wf.id, kind: "action", actionId, label: "报口令", x: 240, y: 0 },
      { id: nOut, workflowId: wf.id, kind: "output", objectTypeId: tOut, label: "回执", x: 480, y: 0 },
    ])
    .run();
  db.insert(workflowEdges)
    .values([
      { workflowId: wf.id, sourceNodeId: nIn, sourcePort: "value", targetNodeId: nA, targetPort: "题目" },
      { workflowId: wf.id, sourceNodeId: nA, sourcePort: "回执", targetNodeId: nOut, targetPort: "value" },
    ])
    .run();

  const started = await startRun(wf.id, { [nIn]: { kind: "text", text: "请报口令并盖章。" } });
  if (!started.ok) throw new Error(`启动失败：${JSON.stringify(started)}`);
  console.log(`运行已启动：${started.runId}`);

  const t0 = Date.now();
  let runRow: typeof runs.$inferSelect | undefined;
  for (;;) {
    runRow = db.select().from(runs).where(eq(runs.id, started.runId)).get();
    if (runRow && runRow.status !== "running") break;
    if (Date.now() - t0 > 600_000) throw new Error("超时");
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`\n终态：${runRow!.status}${runRow!.error ? `（${runRow!.error}）` : ""}`);
  console.log(`导入摘要：${JSON.stringify(runRow!.imports)}`);

  const dir = path.join(process.cwd(), runRow!.runDir!);
  const link = path.join(dir, "workspace", ".agents", "skills", slug);
  console.log(`技能链接：${fs.existsSync(link) ? `→ ${fs.readlinkSync(link)}` : "不存在 ✗"}`);
  const plugin = path.join(dir, "plugins", `${toolName}.ts`);
  console.log(`工具插件：${fs.existsSync(plugin) ? "已物化 ✓" : "不存在 ✗"}`);

  const receipt = path.join(dir, "workspace", "receipt.md");
  if (fs.existsSync(receipt)) {
    const text = fs.readFileSync(receipt, "utf8");
    console.log(`\n产物 receipt.md：\n${text}`);
    console.log(`口令来自技能：${text.includes("青山不改") ? "✓" : "✗"}`);
    console.log(`印章来自工具：${text.includes("【冒烟印章】") ? "✓" : "✗"}`);
  }
  const toolCalls = db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, started.runId))
    .all()
    .filter((e) => e.type === "tool");
  const names = [...new Set(toolCalls.map((e) => (e.payload as { tool?: string })?.tool))];
  console.log(`调用过的工具：${names.join(", ")}`);
  for (const n of db.select().from(runNodes).where(eq(runNodes.runId, started.runId)).all()) {
    console.log(`  ${n.label.padEnd(6)} ${n.status}${n.error ? ` 错误=${n.error}` : ""}`);
  }
}

await main();
