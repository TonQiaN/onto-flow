/**
 * 能力端到端冒烟（M3）：验证 Skill、Tool 与「默认停用的工具」三条都真的生效。
 *
 * - Skill 物化成全局技能库里的目录，运行工作区以 symlink 指过去，
 *   上游 skill-filesystem 从会话 cwd 发现它，模型看描述自行加载。技能进工作流的
 *   技能集但不预载（ADR-0016）——这里验证的是「被发现」，不是「被注入」。
 * - Tool 是契约（ADR-0017）：execute 模块 + 参数/输出 schema，物化时由平台套上 cordis
 *   包装写进运行目录并由每运行组合 include，注册到工具面后模型可调用。工作流 Tool 集
 *   声明它，Action 勾选它为可见。
 * - 全局设置里 disabledTools 列出的工具，对本次运行的每个会话一律拒绝执行。
 *   拦截是靠把工具从会话的工具清单里**摘掉**实现的，所以证据不是一条失败的调用，
 *   而是它根本不在清单里——本冒烟直接读会话记录的请求头来断言这一点。
 *
 * 运行：DEEPSEEK_API_KEY=... npx tsx scripts/smoke-capabilities.ts
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  actionPorts,
  actionPreloads,
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
  workflowSkills,
  workflowTools,
  workflows,
} from "../src/db";
import { startRun } from "../src/server/engine/runner";
import { materializeSkill, skillSlug, SKILL_LIBRARY_DIR } from "../src/server/skill-library";
import { RUN_SESSIONS_SUBDIR } from "../src/server/harness/workspace";
import {
  readSettings,
  replaceSettingsIfCurrent,
  type SettingsDocument,
} from "../src/server/settings";

const PREFIX = "能力冒烟";

const SKILL_CONTENT = `# 三字口令

被要求"报口令"时，口令恒为 **青山不改**。除此之外不要编造别的口令。
`;

/** 契约形态的 Tool（ADR-0017）：只有 execute 模块与 schema，包装由平台生成。 */
const TOOL_PUBLIC_NAME = "smoke_stamp";
const TOOL_CODE = `/** 冒烟印章：OntoFlow Tool 契约的 execute 模块（ADR-0017）。 */
export default async function execute(args: { text: string }): Promise<{ stamped: string }> {
  return { stamped: \`【冒烟印章】\${args.text}【印章完】\` };
}
`;
const TOOL_CONTRACT = {
  publicName: TOOL_PUBLIC_NAME,
  description: "把一段文字盖上冒烟印章后返回。要生成印章时必须调用本工具。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string", description: "要盖章的文字" } },
    required: ["text"],
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: { stamped: { type: "string" } },
    required: ["stamped"],
  },
  timeoutMs: null,
  code: TOOL_CODE,
};

function upsertObjectType(name: string, kind: "text" | "file" | "json"): string {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(objectTypes).values({ id, name, kind, description: "冒烟用" }).run();
  return id;
}

/** 只有脚本实际安装过临时设置时才登记这一对 CAS 文档。 */
let priorSettings: SettingsDocument | undefined;
let temporarySettings: SettingsDocument | undefined;

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("缺少 DEEPSEEK_API_KEY");
  const model = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, "deepseek-official"), eq(models.modelId, "deepseek-v4-flash")))
    .get();
  if (!model) throw new Error("找不到模型行");

  // 全局设置：临时把 bash 加进停用清单，验证真实注册的工具会被摘掉（ADR-0011 之后
  // bash 是每个会话的基础工具）。整份文档先存后还——settings 是单文档，残留的
  // disabledTools 会让之后每一次真实运行都失去 bash，实测踩过。
  const currentSettings = readSettings();
  if (!currentSettings.disabledTools.includes("bash")) {
    const nextSettings = {
      ...currentSettings,
      disabledTools: [...currentSettings.disabledTools, "bash"],
    };
    if (!replaceSettingsIfCurrent(currentSettings, nextSettings)) {
      throw new Error("全局设置在能力冒烟准备期间被修改，请重试");
    }
    priorSettings = currentSettings;
    temporarySettings = nextSettings;
  }

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

  // Tool：按公名查找（公名是模型调用与收窄用的身份），契约字段整体覆盖。
  let tool = db.select().from(tools).where(eq(tools.publicName, TOOL_PUBLIC_NAME)).get();
  if (!tool) {
    const id = crypto.randomUUID();
    db.insert(tools)
      .values({ id, name: `${PREFIX}印章`, ...TOOL_CONTRACT })
      .run();
    tool = db.select().from(tools).where(eq(tools.id, id)).get()!;
  } else {
    db.update(tools).set(TOOL_CONTRACT).where(eq(tools.id, tool.id)).run();
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
  else
    db.insert(actions)
      .values({ id: actionId, ...row })
      .run();
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
  // 技能不预载：验证的是模型自己从技能集里发现并加载；Tool 勾选为本 Action 可见。
  db.delete(actionPreloads).where(eq(actionPreloads.actionId, actionId)).run();
  db.delete(actionTools).where(eq(actionTools.actionId, actionId)).run();
  db.insert(actionTools).values({ actionId, toolId: tool!.id }).run();

  const wfName = `${PREFIX}·技能与工具`;
  let wf = db.select().from(workflows).where(eq(workflows.name, wfName)).get();
  if (!wf) {
    const id = crypto.randomUUID();
    db.insert(workflows)
      .values({
        id,
        name: wfName,
        description: "M3 验收：技能与工具进运行",
        instructions: `# ${wfName}\n\n技能与工具的能力冒烟。\n`,
      })
      .run();
    wf = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
  }
  // 工作流声明技能集与 Tool 集（ADR-0016）：技能对全部 Action 可见，Tool 声明即物化。
  db.delete(workflowSkills).where(eq(workflowSkills.workflowId, wf.id)).run();
  db.insert(workflowSkills).values({ workflowId: wf.id, skillId: skill.id, position: 0 }).run();
  db.delete(workflowTools).where(eq(workflowTools.workflowId, wf.id)).run();
  db.insert(workflowTools).values({ workflowId: wf.id, toolId: tool!.id, position: 0 }).run();
  db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
  db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();
  const nIn = crypto.randomUUID();
  const nA = crypto.randomUUID();
  const nOut = crypto.randomUUID();
  db.insert(workflowNodes)
    .values([
      { id: nIn, workflowId: wf.id, kind: "input", objectTypeId: tIn, label: "题目", x: 0, y: 0 },
      { id: nA, workflowId: wf.id, kind: "action", actionId, label: "报口令", x: 240, y: 0 },
      {
        id: nOut,
        workflowId: wf.id,
        kind: "output",
        objectTypeId: tOut,
        label: "回执",
        x: 480,
        y: 0,
      },
    ])
    .run();
  db.insert(workflowEdges)
    .values([
      {
        workflowId: wf.id,
        sourceNodeId: nIn,
        sourcePort: "value",
        targetNodeId: nA,
        targetPort: "题目",
      },
      {
        workflowId: wf.id,
        sourceNodeId: nA,
        sourcePort: "回执",
        targetNodeId: nOut,
        targetPort: "value",
      },
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
  const plugin = path.join(dir, "plugins", `tool-${tool!.id}.ts`);
  console.log(`工具插件：${fs.existsSync(plugin) ? "已物化 ✓" : "不存在 ✗"}`);

  const receipt = path.join(dir, "workspace", "receipt.md");
  if (fs.existsSync(receipt)) {
    const text = fs.readFileSync(receipt, "utf8");
    console.log(`\n产物 receipt.md：\n${text}`);
    console.log(`口令来自技能：${text.includes("青山不改") ? "✓" : "✗"}`);
    console.log(`印章来自工具：${text.includes("【冒烟印章】") ? "✓" : "✗"}`);
  }
  // 全局设置：把 bash 加进默认停用清单，本次运行应当拦下它。
  const toolCalls = db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, started.runId))
    .all()
    .filter((e) => e.type === "tool");
  const names = [...new Set(toolCalls.map((e) => (e.payload as { tool?: string })?.tool))];
  console.log(`调用过的工具：${names.join(", ")}`);
  // 全局停用是把工具从清单里摘掉，所以证据在会话请求头里，不在调用记录里。
  const sessionFile = fs
    .readdirSync(path.join(dir, RUN_SESSIONS_SUBDIR), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? fs
            .readdirSync(path.join(dir, RUN_SESSIONS_SUBDIR, entry.name), { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) =>
              path.join(dir, RUN_SESSIONS_SUBDIR, entry.name, child.name, "session.jsonl"),
            )
        : [],
    )
    .find((file) => fs.existsSync(file));
  if (sessionFile) {
    for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as {
        type?: string;
        data?: { header?: { tools?: Array<{ name?: string }> } };
      };
      if (event.type !== "request/header") continue;
      const visible = (event.data?.header?.tools ?? []).map((t) => t.name ?? "?").sort();
      console.log(`会话可见工具：${visible.join(", ")}`);
      console.log(`bash 已被全局设置摘掉：${visible.includes("bash") ? "✗" : "✓"}`);
      console.log(`自建工具在清单里：${visible.includes("smoke_stamp") ? "✓" : "✗"}`);
      break;
    }
  }
  for (const n of db.select().from(runNodes).where(eq(runNodes.runId, started.runId)).all()) {
    console.log(`  ${n.label.padEnd(6)} ${n.status}${n.error ? ` 错误=${n.error}` : ""}`);
  }
}

try {
  await main();
} finally {
  // 只撤销脚本自己安装且仍未被用户改动的临时文档；运行期间的新保存永远胜出。
  if (priorSettings !== undefined && temporarySettings !== undefined) {
    const restored = replaceSettingsIfCurrent(temporarySettings, priorSettings);
    if (!restored) console.warn("全局设置已由其他操作更新，能力冒烟未覆盖该新版本");
  }
}
