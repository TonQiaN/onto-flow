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
 * 会真实调用模型并产生费用。**七项检查任何一项不过即非零退出**（夹具在 smoke-fixture.ts）。
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, runEvents } from "../src/db";
import { startRun } from "../src/server/engine/runner";
import { RUN_SESSIONS_SUBDIR } from "../src/server/harness/workspace";
import { skillSlug, SKILL_LIBRARY_DIR } from "../src/server/skill-library";
import {
  readSettings,
  replaceSettingsIfCurrent,
  type SettingsDocument,
} from "../src/server/settings";
import {
  assertDeclaredArtifacts,
  assertSmoke,
  awaitTerminal,
  printNodes,
  requireCredential,
  requireModel,
  upsertAction,
  upsertObjectType,
  upsertSkill,
  upsertTool,
  upsertWorkflow,
} from "./smoke-fixture";

const PREFIX = "能力冒烟";
const N_IN = "capabilities-smoke-input";
const N_ACTION = "capabilities-smoke-action";
const N_OUT = "capabilities-smoke-output";

const PASSPHRASE = "青山不改";
const STAMP_MARK = "【冒烟印章】";

const SKILL_CONTENT = `# 三字口令

被要求"报口令"时，口令恒为 **${PASSPHRASE}**。除此之外不要编造别的口令。
`;

/** 契约形态的 Tool（ADR-0017）：只有 execute 模块与 schema，包装由平台生成。 */
const TOOL_PUBLIC_NAME = "smoke_stamp";
const TOOL_CODE = `/** 冒烟印章：OntoFlow Tool 契约的 execute 模块（ADR-0017）。 */
export default async function execute(args: { text: string }): Promise<{ stamped: string }> {
  return { stamped: \`${STAMP_MARK}\${args.text}【印章完】\` };
}
`;
const TOOL_CONTRACT = {
  name: `${PREFIX}印章`,
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

/** 只有脚本实际安装过临时设置时才登记这一对 CAS 文档。 */
let priorSettings: SettingsDocument | undefined;
let temporarySettings: SettingsDocument | undefined;

async function main(): Promise<void> {
  requireCredential();
  const model = requireModel();

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

  // Skill 与 Tool 都经写入器落库（同一事务记修订，技能的磁盘投影由写入器物化），
  // 且与其余夹具同一条幂等纪律：定义没变就一个字节都不写，不给库里堆同样的修订。
  const skill = upsertSkill({
    name: `${PREFIX}口令`,
    description: "报口令时该用的规则",
    content: SKILL_CONTENT,
  });
  const slug = skillSlug(skill);
  console.log(`技能投影：${path.join(SKILL_LIBRARY_DIR, slug)}/SKILL.md（slug=${slug}）`);
  const tool = upsertTool(TOOL_CONTRACT);

  const tIn = upsertObjectType(`${PREFIX}题目`, "text");
  const tOut = upsertObjectType(`${PREFIX}回执`, "file");

  // 技能不预载：验证的是模型自己从技能集里发现并加载；Tool 勾选为本 Action 可见。
  const actionId = upsertAction({
    name: `${PREFIX}·报口令`,
    prompt:
      "先报出口令——口令的规则在你的技能里，先把那个技能加载出来再答，不要凭空猜。" +
      "拿到口令后，调用 smoke_stamp 工具给它盖章，把盖章后的整串写进产物。",
    rule: "口令必须来自技能，印章必须来自工具调用，两样都不许自己编。",
    modelId: model.id,
    inputs: [{ name: "题目", objectTypeId: tIn }],
    outputs: [{ name: "回执", objectTypeId: tOut, artifactPath: "receipt.md" }],
    toolIds: [tool.id],
  });

  // 工作流声明技能集与 Tool 集（ADR-0016）：技能对全部 Action 可见，Tool 声明即物化。
  const wfName = `${PREFIX}·技能与工具`;
  const wf = upsertWorkflow({
    name: wfName,
    description: "M3 验收：技能与工具进运行",
    instructions: `# ${wfName}\n\n技能与工具的能力冒烟。\n`,
    skillIds: [skill.id],
    toolIds: [tool.id],
    nodes: [
      { id: N_IN, kind: "input", actionId: null, objectTypeId: tIn, label: "题目", x: 0, y: 0 },
      {
        id: N_ACTION,
        kind: "action",
        actionId,
        objectTypeId: null,
        label: "报口令",
        x: 240,
        y: 0,
      },
      {
        id: N_OUT,
        kind: "output",
        actionId: null,
        objectTypeId: tOut,
        label: "回执",
        x: 480,
        y: 0,
      },
    ],
    edges: [
      {
        id: "capabilities-smoke-e1",
        sourceNodeId: N_IN,
        sourcePort: "value",
        targetNodeId: N_ACTION,
        targetPort: "题目",
      },
      {
        id: "capabilities-smoke-e2",
        sourceNodeId: N_ACTION,
        sourcePort: "回执",
        targetNodeId: N_OUT,
        targetPort: "value",
      },
    ],
  });

  const started = await startRun(wf.id, { [N_IN]: { kind: "text", text: "请报口令并盖章。" } });
  if (!started.ok) throw new Error(`启动失败：${JSON.stringify(started)}`);
  console.log(`运行已启动：${started.runId}`);

  const runRow = await awaitTerminal(started.runId, { timeoutMs: 600_000 });
  console.log(`导入摘要：${JSON.stringify(runRow.imports)}`);
  printNodes(started.runId);
  const artifacts = assertDeclaredArtifacts(started.runId, [`${N_ACTION}·回执`]);

  const runDir = runRow.runDir;
  assertSmoke(runDir !== null, "成功的运行没有运行目录");
  const dir = path.join(process.cwd(), runDir);

  // ① 技能以 symlink 进了工作区
  const link = path.join(dir, "workspace", ".agents", "skills", slug);
  assertSmoke(fs.existsSync(link), `技能链接不存在：${link}`);
  console.log(`技能链接：→ ${fs.readlinkSync(link)}`);

  // ② Tool 契约被平台包装成了 cordis 插件
  const plugin = path.join(dir, "plugins", `tool-${tool.id}.ts`);
  assertSmoke(fs.existsSync(plugin), `Tool 包装插件没有物化：${plugin}`);
  console.log(`工具插件：已物化 ${plugin}`);

  // ③④ 口令来自技能、印章来自工具调用
  // required 里点了名，assertDeclaredArtifacts 没抛就一定有这一项。
  const receipt = artifacts.get(`${N_ACTION}·回执`)!;
  const text = fs.readFileSync(receipt, "utf8");
  console.log(`\n产物 receipt.md：\n${text}`);
  assertSmoke(text.includes(PASSPHRASE), `产物里没有技能里的口令「${PASSPHRASE}」`);
  assertSmoke(text.includes(STAMP_MARK), `产物里没有工具盖的印章「${STAMP_MARK}」`);

  // ⑤ 印章那串字模型自己也抄得出来，所以只看产物不够：要求事件日志里有一条
  // smoke_stamp 的成功结果（tool/result 落库为 status: "ok"）。
  const toolEvents = db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, started.runId))
    .all()
    .filter((e) => e.type === "tool")
    .map((e) => e.payload as { tool?: string; status?: string });
  console.log(`调用过的工具：${[...new Set(toolEvents.map((e) => e.tool))].join(", ")}`);
  assertSmoke(
    toolEvents.some((e) => e.tool === TOOL_PUBLIC_NAME && e.status === "ok"),
    `事件日志里没有一次成功的 ${TOOL_PUBLIC_NAME} 调用：印章可能是模型自己抄的`,
  );

  // ⑥⑦ 全局停用是把工具从清单里摘掉，所以证据在会话请求头里，不在调用记录里。
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
  assertSmoke(sessionFile !== undefined, "运行目录里没有会话记录，无法核对可见工具清单");
  const header = fs
    .readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          data?: { header?: { tools?: Array<{ name?: string }> } };
        },
    )
    .find((event) => event.type === "request/header");
  assertSmoke(header !== undefined, "会话记录里没有 request/header，无法核对可见工具清单");
  const visible = (header.data?.header?.tools ?? []).map((t) => t.name ?? "?").sort();
  console.log(`会话可见工具：${visible.join(", ")}`);
  assertSmoke(!visible.includes("bash"), "bash 在全局停用清单里，却仍出现在会话工具清单中");
  assertSmoke(
    visible.includes(TOOL_PUBLIC_NAME),
    `自建工具 ${TOOL_PUBLIC_NAME} 不在会话工具清单中`,
  );
  console.log("\n能力冒烟通过。");
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
