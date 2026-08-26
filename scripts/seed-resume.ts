/**
 * 「简历匹配评分」工作流的种子（M4 第二个验收案例）。
 *
 * 形态：两个输入 → 解析 → 六个评委静态扇出 → 汇总。
 *
 *   岗位JD文件 ─┐
 *               ├─> 解析 ─┬─> 硬性条件审查 ─┐
 *   简历文件 ───┘         ├─> 技能匹配 ─────┤
 *                         ├─> 经验深度 ─────┼─> 汇总评分 ─> 评分报告
 *                         ├─> 领域匹配 ─────┤
 *                         ├─> 履历稳定性 ───┤
 *                         └─> 真实性风险 ───┘
 *
 * 扇出是图的形状而不是节点类型（ADR-0009）：解析的两个输出端口各连出六条线，
 * 六个评委并行跑；汇总的两个输入端口各接进六条线，它读齐全部产物再出结论。
 *
 * 幂等：按名字查找，存在则更新。运行：npx tsx scripts/seed-resume.ts
 */
import { eq } from "drizzle-orm";
import {
  actionPorts,
  actions,
  db,
  models,
  objectTypes,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";

interface PortSpec {
  name: string;
  objectTypeId: string;
  artifactPath?: string;
}

function upsertObjectType(name: string, kind: "text" | "file" | "json", description: string): string {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, name)).get();
  if (existing) {
    db.update(objectTypes).set({ description }).where(eq(objectTypes.id, existing.id)).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(objectTypes).values({ id, name, kind, description }).run();
  return id;
}

function upsertAction(input: {
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  effort: "off" | "low" | "high" | "max";
  inputs: PortSpec[];
  outputs: PortSpec[];
}): string {
  const existing = db.select().from(actions).where(eq(actions.name, input.name)).get();
  const id = existing?.id ?? crypto.randomUUID();
  const row = {
    name: input.name,
    description: input.description,
    prompt: input.prompt,
    rule: input.rule,
    modelId: input.modelId,
    reasoningEffort: input.effort,
    maxReentries: 0,
    onExhausted: "fail" as const,
  };
  if (existing) db.update(actions).set(row).where(eq(actions.id, id)).run();
  else db.insert(actions).values({ id, ...row }).run();

  db.delete(actionPorts).where(eq(actionPorts.actionId, id)).run();
  input.inputs.forEach((p, i) =>
    db
      .insert(actionPorts)
      .values({ actionId: id, direction: "input", name: p.name, objectTypeId: p.objectTypeId, position: i })
      .run(),
  );
  input.outputs.forEach((p, i) =>
    db
      .insert(actionPorts)
      .values({
        actionId: id,
        direction: "output",
        name: p.name,
        objectTypeId: p.objectTypeId,
        artifactPath: p.artifactPath ?? null,
        position: i,
      })
      .run(),
  );
  return id;
}

const model = db
  .select()
  .from(models)
  .where(eq(models.modelId, "deepseek-v4-flash"))
  .get();
if (!model) throw new Error("找不到 deepseek-v4-flash 模型行，先跑 npm run db:seed");

const tJdFile = upsertObjectType("岗位JD文件", "file", "岗位描述原文件（Markdown 或纯文本）");
const tResumeFile = upsertObjectType("简历文件", "file", "简历原文件（Markdown 或纯文本）");
const tJdMd = upsertObjectType("岗位要求Markdown", "file", "解析后的岗位要求，含逐条硬性条件");
const tResumeMd = upsertObjectType("简历Markdown", "file", "解析后的简历全文，已脱敏");
const tVerdict = upsertObjectType("评委结论", "file", "单个维度的评分结论与证据");
const tReport = upsertObjectType("评分报告", "file", "汇总后的最终评分报告");

const EVIDENCE_RULE =
  "每条评价都必须能指到简历原文的一处直引，直引不超过一句；指不出原文的结论不要写。" +
  "简历没写的只等于未证实，不等于不具备。不依据学校与公司的名气加减分，" +
  "不依据姓名、性别、年龄、籍贯、婚育作任何判断。";

const parse = upsertAction({
  name: "简历评分·解析",
  description: "把岗位与简历原文件解析成结构化 Markdown，并从 JD 抽出逐条硬性条件。",
  prompt:
    "把岗位与简历两份原文件解析成结构化 Markdown，路径见「你要读的东西」，两份都要整份读进来。\n\n" +
    "岗位要求写进对应产物，按这个结构：\n" +
    "1. `## 岗位概要`：一句话说清是什么岗、什么业务；\n" +
    "2. `## 硬性条件`：逐条列出，每条一句、可判定（学历、年限、技术栈、地点、语言、工作许可等）；" +
    "JD 写成加分项的不要列进来；\n" +
    "3. `## 技能要求`：逐项列出 JD 明确点名的技术；\n" +
    "4. `## 加分项`：原样保留。\n\n" +
    "简历写进对应产物：按简历自身的章节顺序还原，不重排、不补写、不润色、不合并条目。" +
    "时间归一为 YYYY-MM 或 YYYY，原文写「至今」时记 present。",
  rule:
    "忠实优先于美观：原文是英文就保留英文，无法辨认的片段原位标注 [无法辨认]。" +
    "联系方式（电话、邮箱、住址、证件号）一律以 [已脱敏] 占位。" +
    "两份产物都必须是全文而不是摘要——后续所有评委只看这两份文件，这里丢掉的信息下游无法恢复。",
  modelId: model.id,
  effort: "low",
  inputs: [
    { name: "岗位文件", objectTypeId: tJdFile },
    { name: "简历文件", objectTypeId: tResumeFile },
  ],
  outputs: [
    { name: "岗位要求", objectTypeId: tJdMd, artifactPath: "job.md" },
    { name: "简历", objectTypeId: tResumeMd, artifactPath: "resume.md" },
  ],
});

/** 六个评委：同一套输入输出形状，只有职责与评分口径不同。 */
const CRITICS: Array<{ key: string; name: string; focus: string; scoring: string }> = [
  {
    key: "must-have",
    name: "简历评分·硬性条件",
    focus:
      "逐条核对岗位要求里「硬性条件」的每一项：简历中有明确证据满足记「满足」，" +
      "明确不满足记「不满足」，没写记「未提及」。未提及不等于不满足。",
    scoring:
      "本维度是否决维度，分数只取 0 或 100：出现任一条「不满足」记 0 并说明是哪一条，否则记 100。",
  },
  {
    key: "skill-match",
    name: "简历评分·技能匹配",
    focus:
      "把岗位要求里的技能项逐个在简历里查证，分三档：直接命中（写明用过并有具体场景）、" +
      "间接命中（相近技术栈，必须说明相近在哪）、未提及。只出现在技能清单、" +
      "正文经历里找不到对应场景的，记为「仅列举」，不算直接命中。",
    scoring: "按命中比例与该技能对岗位的关键程度加权，不按简历罗列的技能总数。",
  },
  {
    key: "experience-depth",
    name: "简历评分·经验深度",
    focus:
      "看职责层级、独立度、项目规模与复杂度，不看年限数字。区分「参与」「负责」「主导」，" +
      "区分课程或个人项目与生产系统。",
    scoring:
      "并发量、数据量、团队人数这类可核查的量化描述是加分依据；没有量化描述时按证据不足处理，不按经验不足处理。",
  },
  {
    key: "domain-fit",
    name: "简历评分·领域匹配",
    focus: "判断过往的行业、业务场景与客户类型能否接上本岗位。",
    scoring:
      "跨行但底层问题同构时（例如同为高并发交易系统），明确写出同构点，不因行业名称不同直接扣分。",
  },
  {
    key: "stability",
    name: "简历评分·履历稳定性",
    focus: "逐段列出起止时间与在职时长，看分布、空窗与职业方向连续性。",
    scoring:
      "空窗与短期在职只作事实陈述并转成面试提问，不作道德判断；" +
      "简历中已说明原因的求学、服役、育儿、创业等空窗不扣分。",
  },
  {
    key: "red-flag",
    name: "简历评分·真实性风险",
    focus:
      "只找能在简历内部自证的问题：时间线重叠或矛盾、职级与年限不匹配、" +
      "同一段经历前后描述不一致、无法验证的绝对化表述、通篇模板化措辞而无具体事实。",
    scoring:
      "不得基于外部世界知识断言真伪。本维度是否决维度，分数只取 0 或 100：" +
      "发现足以否决的伪造迹象记 0，没有发现明确写「未发现」并记 100。",
  },
];

const criticIds = CRITICS.map((critic) =>
  upsertAction({
    name: critic.name,
    description: `简历评分的一个评委：${critic.focus.slice(0, 24)}…`,
    prompt:
      `你是这次评分的一位评委，只负责一个维度。岗位要求与简历全文的路径见「你要读的东西」，两份都要先读。\n\n` +
      `## 你判什么\n\n${critic.focus}\n\n## 怎么给分\n\n${critic.scoring}\n\n` +
      "## 结论怎么写\n\n把结论写进你的产物，结构如下：\n\n" +
      "```markdown\n# <维度名>\n\n## 结论\n一段话说清判断与分数依据。\n\n" +
      "## 逐条发现\n- **<核对项>** — 满足 / 不满足 / 未提及 / 优势 / 顾虑\n" +
      "  - 证据：「<简历原文直引，不超过一句>」\n\n" +
      "## 面试提问\n- <针对未提及项或顾虑的具体问题>\n```\n\n" +
      "第一行之后另起一行写 `分数：<0-100 的整数>`，汇总节点按它取分。",
    rule:
      `${EVIDENCE_RULE} 只评你这一个维度，越界评论别的维度会与那位评委的结论重复计入。` +
      "不看其他评委的结论，也不猜测最终结果。",
    modelId: model.id,
    effort: "low",
    inputs: [
      { name: "岗位要求", objectTypeId: tJdMd },
      { name: "简历", objectTypeId: tResumeMd },
    ],
    outputs: [
      { name: "结论", objectTypeId: tVerdict, artifactPath: `scores/${critic.key}.md` },
    ],
  }),
);

const report = upsertAction({
  name: "简历评分·汇总",
  description: "读齐全部评委结论，汇总成最终评分报告。",
  prompt:
    "把全部评委的结论汇总成这次运行的最终评分报告。各评委结论的路径见「你要读的东西」，" +
    "共六份，逐个读完再汇总——不要只看某一份就下结论。\n\n" +
    "报告写进产物，按这个结构：\n" +
    "1. `## 总评`：总分（0-100 整数）、档位、结论；\n" +
    "2. `## 分维度得分`：逐维度列出分数与一句话理由；\n" +
    "3. `## 优势`与`## 顾虑`：逐条保留原评委的证据原文，不重写、不合并成笼统的话；\n" +
    "4. `## 待确认`：收集所有「简历未提及」的项；\n" +
    "5. `## 面试提问`：从各评委的提问去重后取 5 到 8 条；\n" +
    "6. `## 分歧`：评委之间结论矛盾的，两条都保留并写明矛盾在哪。\n\n" +
    "总分算法：非否决维度（技能匹配、经验深度、领域匹配、履历稳定性）取算术平均，" +
    "四舍五入取整。档位：85 及以上强匹配，70 到 84 良好，55 到 69 部分匹配，54 及以下弱匹配。" +
    "任一否决维度（硬性条件、真实性风险）为 0 时，结论记「否决」并写明原因，" +
    "总分照常计算并保留——否决原因和匹配程度要分开看。",
  rule:
    "你不重新评分也不推翻单维结论：需要改分的情形写进「分歧」交人判断。" +
    "单维度分数与其结论明显不自洽的，也记进「分歧」。简历原文只经证据直引传递，报告里不出现完整简历。",
  modelId: model.id,
  effort: "high",
  inputs: [{ name: "评委结论", objectTypeId: tVerdict }],
  outputs: [{ name: "报告", objectTypeId: tReport, artifactPath: "report.md" }],
});

// ---------------------------------------------------------------------------
// 工作流：两个输入 → 解析 → 六个评委并行 → 汇总 → 输出
// ---------------------------------------------------------------------------

const WF_NAME = "简历匹配评分";
let wf = db.select().from(workflows).where(eq(workflows.name, WF_NAME)).get();
if (!wf) {
  const id = crypto.randomUUID();
  db.insert(workflows)
    .values({
      id,
      name: WF_NAME,
      description: "一个岗位对一份简历：解析成 Markdown，六个角色分维度打分，汇总为评分报告。",
    })
    .run();
  wf = db.select().from(workflows).where(eq(workflows.id, id)).get()!;
} else {
  db.update(workflows)
    .set({ description: "一个岗位对一份简历：解析成 Markdown，六个角色分维度打分，汇总为评分报告。" })
    .where(eq(workflows.id, wf.id))
    .run();
}
db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id)).run();
db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id)).run();

const nJd = crypto.randomUUID();
const nResume = crypto.randomUUID();
const nParse = crypto.randomUUID();
const nReport = crypto.randomUUID();
const nOut = crypto.randomUUID();
const criticNodes = CRITICS.map(() => crypto.randomUUID());

db.insert(workflowNodes)
  .values([
    { id: nJd, workflowId: wf.id, kind: "input", objectTypeId: tJdFile, label: "岗位JD", x: 0, y: 80 },
    { id: nResume, workflowId: wf.id, kind: "input", objectTypeId: tResumeFile, label: "简历", x: 0, y: 260 },
    { id: nParse, workflowId: wf.id, kind: "action", actionId: parse, label: "解析", x: 260, y: 170 },
    ...criticNodes.map((id, i) => ({
      id,
      workflowId: wf!.id,
      kind: "action" as const,
      actionId: criticIds[i],
      label: CRITICS[i].name.replace("简历评分·", ""),
      x: 540,
      y: i * 110,
    })),
    { id: nReport, workflowId: wf.id, kind: "action", actionId: report, label: "汇总", x: 820, y: 280 },
    { id: nOut, workflowId: wf.id, kind: "output", objectTypeId: tReport, label: "评分报告", x: 1080, y: 280 },
  ])
  .run();

db.insert(workflowEdges)
  .values([
    { workflowId: wf.id, sourceNodeId: nJd, sourcePort: "value", targetNodeId: nParse, targetPort: "岗位文件" },
    { workflowId: wf.id, sourceNodeId: nResume, sourcePort: "value", targetNodeId: nParse, targetPort: "简历文件" },
    // 扇出：解析的两个输出端口各连出六条线，六个评委并行跑
    ...criticNodes.flatMap((id) => [
      { workflowId: wf!.id, sourceNodeId: nParse, sourcePort: "岗位要求", targetNodeId: id, targetPort: "岗位要求" },
      { workflowId: wf!.id, sourceNodeId: nParse, sourcePort: "简历", targetNodeId: id, targetPort: "简历" },
    ]),
    // 汇总：一个输入端口接进六条线，节点读齐全部产物
    ...criticNodes.map((id) => ({
      workflowId: wf!.id,
      sourceNodeId: id,
      sourcePort: "结论",
      targetNodeId: nReport,
      targetPort: "评委结论",
    })),
    { workflowId: wf.id, sourceNodeId: nReport, sourcePort: "报告", targetNodeId: nOut, targetPort: "value" },
  ])
  .run();

console.log(`工作流「${WF_NAME}」已就绪：${wf.id}`);
console.log(`  节点 ${3 + CRITICS.length + 2} 个，评委 ${CRITICS.length} 位`);
