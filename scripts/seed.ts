/**
 * FlowForge 种子脚本：首个案例「采购集采计划生成」。
 *
 * 运行：npm run db:seed（tsx scripts/seed.ts）；执行前需先 npm run db:push 建表。
 * 幂等：命名实体按 name 查找，存在则 update 内容（id 保持稳定）、不存在则 insert；
 * 关联表（动作端口/技能/工具关联、工作流节点/连线、实体标签）先删后插，
 * 修订只在该实体尚无任何修订时补写第 1 版——重复执行不产生重复行。
 */
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import {
  actionPorts,
  actions,
  actionSkills,
  actionTools,
  db,
  type EntityKind,
  entityTags,
  models,
  objectTypes,
  revisions,
  skills,
  tags,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
} from "../src/db";
import { recordRevision } from "../src/server/revisions";

// ---------------------------------------------------------------------------
// 内容常量（全部内联，来源：research/erp-seed.json）
// ---------------------------------------------------------------------------

const SKILL_BIANZHI_CONTENT = `# 集采计划编制规范

本规范约定集中采购计划（集采计划）文档的章节结构、需求汇总与合并规则、品类划分、数量与预算口径及时间安排要求。编制底线有两条：一、所有关键数值（数量、金额、日期）必须能追溯到输入的需求资料，不得凭空生成；二、资料缺失或无法判定的信息，一律显式标注「待确认」，不得臆断补齐。

## 一、章节结构
一份合格的集采计划应包含以下七个章节：
1. **计划概述**：计划名称与编号、计划年度/周期、编制依据（本次需求收集的范围与来源）、涉及的需求部门或成员单位清单、编制日期。
2. **需求汇总总览**：明细总行数、涉及部门数、品类数、预算总额，以及主要品类的数量与金额分布。
3. **需求明细与合并结果**：以行为最小单位列出汇总后的需求，每行含需求部门/单位、品目名称与规格、合并后数量、计量单位、预估单价、预估金额、需求时间。合并行必须注明由哪些部门的哪几条原始需求合并而来，保持行级可追溯。
4. **品类划分与集采分类**：各需求行归入的采购品类，以及本计划的集采分类归属与判定依据。
5. **数量与预算口径**：数量与金额的统计口径说明。
6. **时间安排**：分批次的采购启动与到货节点安排。
7. **风险与待确认事项**：信息缺失、口径不明、需业务方澄清事项的汇总清单。

## 二、需求汇总与合并规则
- 汇总以行为单位；一份集采计划可同时包含多个部门/单位的需求，不按单位拆分成多份计划。
- **同类合并**：品目名称、规格型号、计量单位一致（或有充分依据判定为同一物资）的需求行方可合并数量，且必须写明合并依据（如规格一致、可统一型号）。规格描述不全、无法确认是否同一物资的，不得合并，单列并标注「需确认是否可合并」。
- 合并行总数量必须等于被合并各行数量之和，金额同理；汇总数与明细对不上的文档视为不合格。
- 不同部门对同类物资的配置/档次要求不同的，不强行归一，按配置分组呈现；统一规格的意见只能以「建议」给出，不改动原始需求。

## 三、品类划分
- 按物资自然属性与采购管理习惯划分品类（如计算机及配件、办公家具、办公自动化设备、网络设备等），每条需求行归入且仅归入一个品类。
- 有集采目录或分类依据时，按其判定品类应走的集采级别（一级集采/二三级集采/自定义集采）；资料未提供判定依据时，集采分类只作为建议给出，并标注「集采分类依据待确认」。

## 四、数量与预算口径
- 数量必须大于零；计量单位统一后方可加总，单位不一致且无法换算的不得加总。
- 预估金额 = 数量 × 预估单价；资料只给总价的可反推单价并注明「由总价反推」。
- 必须写明价格口径（是否含税等）；资料未说明的，沿用原文并标注「口径以需求方原文为准，未确认是否含税」。
- 引用历史价或参考价时必须同时说明来源；无来源的参考价不得写入。
- 涉及不同预算类型（项目预算/企业预算）的分别列示；需求方明示预算上限而汇总结果超出的，必须显式提示，不做静默处理。

## 五、时间安排
- 以各需求行的期望到货时间为基准，把需求时间相近的行归入同一采购批次，给出每批次的建议采购启动时间与到货时间，启动与到货之间须预留合理采购周期。
- 按需求时间倒推出的启动时间已过期或明显来不及的，必须在「风险与待确认事项」中预警，不得擅自调整需求时间。
- 同一物资分批交付的，按批次分别列示时间，不得合并为单一日期。

## 六、行文要求
使用 Markdown 编写，明细用表格呈现，标题层级清晰；全文沿用需求资料中的原始名称与数字，任何推断、建议、假设都必须以「建议」「待确认」字样与事实明确区分。`;

const SKILL_SHENHE_CONTENT = `# 集采计划审核要点

审核对象为按《集采计划编制规范》产出的集采计划文档。逐条执行以下清单，每条给出「通过/不通过/不适用」判定；不通过的必须指出所在章节位置并给出修改建议。审核只做判定，不修改计划正文。

## 一、完整性
1. **章节齐备**：计划概述、需求汇总总览、需求明细与合并结果、品类划分与集采分类、数量与预算口径、时间安排、风险与待确认事项七个章节是否齐全。判定标准：缺任一章节即不通过。
2. **明细要素齐备**：每条需求明细行是否包含部门/单位、品目与规格、数量、计量单位、预估金额（或单价）、需求时间。判定标准：任一行缺要素且未标注「未提供/待确认」即不通过。
3. **单位覆盖一致**：概述中列出的需求部门与明细中出现的部门是否互相覆盖。判定标准：任一侧存在对方没有的部门即不通过。

## 二、口径一致性
4. **汇总-明细一致**：总览中的总行数、部门数、预算总额是否等于明细逐行汇总的结果。判定标准：金额允许四舍五入造成的±1元以内误差，其余不一致即不通过。
5. **合并可追溯**：每个合并行是否注明来源部门与原始数量，且来源数量之和等于合并数量。判定标准：任一合并行不可追溯或加总不符即不通过。
6. **价格口径声明**：金额是否声明含税与否等口径；口径不明处是否显式标注。判定标准：出现既无口径说明又无标注的金额即不通过。
7. **计量单位一致**：同一合并行内计量单位是否一致或已说明换算关系。判定标准：不一致且无换算说明即不通过。

## 三、合规性
8. **无凭空数值**：计划中的数量、金额、日期是否都能对应到需求资料，或被明确标注为建议/假设/待确认。判定标准：发现无来源且未标注的关键数值即不通过。
9. **建议与事实分离**：集采分类、统一规格等推断性内容是否以「建议/待确认」标明。判定标准：把建议写成既定结论即不通过。
10. **待确认事项登记**：正文中所有「待确认」标注是否都汇集到「风险与待确认事项」章节。判定标准：存在散落未登记项即不通过。

## 四、可执行性
11. **批次时间合理**：每个批次的建议启动时间是否早于到货时间且预留了采购周期；对时间上已来不及的需求是否给出预警。判定标准：出现启动晚于到货、或明显来不及却未预警的即不通过。
12. **合并机会识别**：跨部门同品目同规格的需求是否已合并，或说明了不合并的原因。判定标准：存在明显同类需求既未合并也未说明的，判为「有保留」。
13. **品类划分可用**：每条明细是否归入唯一品类，划分粒度是否足以支撑后续分包采购。判定标准：存在未归类明细即不通过。

## 五、审核结论规则
- **通过**：全部条目通过（允许存在「不适用」）。
- **有保留通过**：仅存在不影响数字正确性与完整性的保留项（如第12条）。
- **退回**：任何涉及数字正确性（第4、5、8条）或完整性（第1、2条）的条目不通过。

结论必须附问题清单，每个问题给出：对应检查项编号、所在章节位置、问题描述、修改建议、严重程度（高/中/低）。数字错误一律为「高」。`;

/** 审核评价 Object Type 的 JSON Schema（同时用作结构化输出 schema） */
const REVIEW_JSON_SCHEMA = `{"type":"object","properties":{"conclusion":{"type":"string","enum":["通过","有保留通过","退回"],"description":"审核总结论"},"summary":{"type":"string","description":"总体意见，一段话概括计划质量与主要问题"},"issues":{"type":"array","description":"问题清单，无问题时为空数组","items":{"type":"object","properties":{"checklist_item":{"type":"string","description":"对应审核要点的检查项编号与名称，如「4 汇总-明细一致」"},"category":{"type":"string","enum":["完整性","口径一致性","合规性","可执行性"]},"location":{"type":"string","description":"问题所在章节或明细行位置"},"description":{"type":"string","description":"问题描述"},"suggestion":{"type":"string","description":"修改建议"},"severity":{"type":"string","enum":["高","中","低"],"description":"严重程度，数字错误一律为高"}},"required":["category","location","description","severity"]}}},"required":["conclusion","summary","issues"]}`;

/**
 * save_purchase_plan：完整的 opencode custom tool 源码。
 * 运行在 opencode 的 bun 环境（物化为 <workspace>/.opencode/tools/save_purchase_plan.ts），
 * 不能 import 本项目内任何模块；数据库与备份目录靠 FLOWFORGE_DB_PATH / FLOWFORGE_DATA_DIR 定位。
 */
const SAVE_PURCHASE_PLAN_CODE = `import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

export default tool({
  description:
    "把审核完成的集采计划归档入库：写入 purchase_plans 表（plan_no 冲突时覆盖更新），并把计划全文备份为 Markdown 文件，返回入库记录标识与备份路径。",
  args: {
    plan_no: tool.schema.string().describe("集采计划编号，如 CPP-2027-001"),
    plan_title: tool.schema.string().describe("计划标题"),
    plan_type: tool.schema
      .string()
      .optional()
      .describe("集采分类（一级集采/二三级集采/自定义集采；依据不明时含「待确认」原文）"),
    plan_year: tool.schema.string().optional().describe("计划年度或周期，如 2027"),
    org_units: tool.schema.string().optional().describe("涉及需求部门/单位清单，逗号分隔"),
    category_summary: tool.schema
      .string()
      .optional()
      .describe("品类划分摘要（各品类及其数量/金额分布）"),
    item_count: tool.schema.number().optional().describe("合并后需求明细行数"),
    total_budget: tool.schema.number().optional().describe("预算总额（元），口径见 budget_note"),
    budget_note: tool.schema
      .string()
      .optional()
      .describe("预算与价格口径说明（是否含税、预算类型、是否超上限提示等）"),
    schedule_summary: tool.schema
      .string()
      .optional()
      .describe("时间安排摘要（采购批次与关键到货节点）"),
    pending_issues: tool.schema.string().optional().describe("风险与待确认事项摘要"),
    review_conclusion: tool.schema
      .string()
      .optional()
      .describe("审核总结论（通过/有保留通过/退回）"),
    review_feedback: tool.schema.string().optional().describe("审核评价 JSON 全文"),
    plan_content: tool.schema.string().describe("集采计划 Markdown 全文"),
  },
  async execute(args) {
    try {
      const dbPath = process.env.FLOWFORGE_DB_PATH;
      const dataDir = process.env.FLOWFORGE_DATA_DIR;
      if (!dbPath) {
        return JSON.stringify({ ok: false, error: "缺少环境变量 FLOWFORGE_DB_PATH，无法定位数据库" });
      }
      if (!dataDir) {
        return JSON.stringify({ ok: false, error: "缺少环境变量 FLOWFORGE_DATA_DIR，无法定位备份目录" });
      }
      const createdAt = new Date().toISOString();
      const dateStr = createdAt.slice(0, 10).replace(/-/g, "");
      const db = new Database(dbPath);
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        db.prepare(
          "INSERT INTO purchase_plans (plan_no, plan_title, plan_type, plan_year, org_units, category_summary, item_count, total_budget, budget_note, schedule_summary, review_conclusion, review_feedback, plan_content, pending_issues, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_no) DO UPDATE SET plan_title = excluded.plan_title, plan_type = excluded.plan_type, plan_year = excluded.plan_year, org_units = excluded.org_units, category_summary = excluded.category_summary, item_count = excluded.item_count, total_budget = excluded.total_budget, budget_note = excluded.budget_note, schedule_summary = excluded.schedule_summary, review_conclusion = excluded.review_conclusion, review_feedback = excluded.review_feedback, plan_content = excluded.plan_content, pending_issues = excluded.pending_issues, created_at = excluded.created_at",
        ).run(
          args.plan_no,
          args.plan_title,
          args.plan_type ?? null,
          args.plan_year ?? null,
          args.org_units ?? null,
          args.category_summary ?? null,
          args.item_count ?? null,
          args.total_budget ?? null,
          args.budget_note ?? null,
          args.schedule_summary ?? null,
          args.review_conclusion ?? null,
          args.review_feedback ?? null,
          args.plan_content,
          args.pending_issues ?? null,
          createdAt,
        );
        const backupDir = path.join(dataDir, "documents");
        fs.mkdirSync(backupDir, { recursive: true });
        // plan_no 由模型输出，净化后再拼文件名，防目录穿越写出 documents/ 之外
        const safePlanNo = String(args.plan_no).replace(/[^\\w.-]/g, "_") || "plan";
        const backupPath = path.join(backupDir, "集采计划-" + safePlanNo + "-" + dateStr + ".md");
        fs.writeFileSync(backupPath, args.plan_content, "utf8");
        db.prepare("UPDATE purchase_plans SET backup_path = ? WHERE plan_no = ?").run(
          backupPath,
          args.plan_no,
        );
        const row = db.prepare("SELECT id FROM purchase_plans WHERE plan_no = ?").get(args.plan_no) as
          | { id: number }
          | null;
        return JSON.stringify({
          ok: true,
          id: row ? row.id : null,
          planNo: args.plan_no,
          backupPath,
        });
      } finally {
        db.close();
      }
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
`;

const SAMPLE_REQUIREMENT_TXT = `华远新材科技有限公司 2027年度办公与IT设备采购需求汇总（各部门上报初稿）

一、行政部
1. 人体工学办公椅（带头枕）120把，预算每把800元，2027年3月底前到货；
2. A4黑白多功能一体机（打印/复印/扫描）6台，预算合计9万元，2027年第一季度到货；
3. 会议室视频会议终端2套，预算合计6万元，2027年6月前到货。

二、信息技术部
1. 商用笔记本电脑（i7/16G/512G或同档）150台，预算每台6500元，分两批交付：2027年4月交付90台，2027年9月交付60台；
2. 图形工作站20台，预算合计32万元，2027年5月前到货；
3. 企业级路由器4台、48口千兆交换机10台，预算合计18万元，2027年上半年到货。

三、研发中心
1. 高性能笔记本电脑（仿真计算用，独立显卡）40台，预算每台12000元，2027年4月前到货；
2. 27寸4K显示器80台，预算每台2200元，与笔记本同批到货。

四、财务部
1. 针式发票打印机8台，预算合计2.4万元，2027年3月前到货；
2. 商用笔记本电脑12台，配置参照信息技术部标准，2027年4月到货。

五、人力资源部
1. 办公桌椅套装60套（新办公区启用），预算每套1500元，2027年7月前到货；
2. 培训室激光投影仪3台，预算合计4.5万元，2027年8月前到货。

备注：以上预算均为含税估算价；各部门笔记本电脑可统一型号集中采购；到货地点均为集团总部园区，收货仓库为总部综合库。需求联系人：行政部王莉、信息技术部陈骁、研发中心刘慧。`;

// ---------------------------------------------------------------------------
// 幂等 upsert 工具函数
// ---------------------------------------------------------------------------

function upsertObjectType(input: {
  name: string;
  kind: "text" | "file" | "json";
  description: string;
  jsonSchema?: string | null;
  builtin?: boolean;
}): string {
  const values = {
    kind: input.kind,
    description: input.description,
    jsonSchema: input.jsonSchema ?? null,
    builtin: input.builtin ?? false,
  };
  const existing = db
    .select()
    .from(objectTypes)
    .where(eq(objectTypes.name, input.name))
    .get();
  if (existing) {
    db.update(objectTypes)
      .set(values)
      .where(eq(objectTypes.id, existing.id))
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(objectTypes)
    .values({ id, name: input.name, ...values })
    .run();
  return id;
}

function upsertModel(input: {
  providerId: string;
  modelId: string;
  displayName: string;
}): string {
  const existing = db
    .select()
    .from(models)
    .where(
      and(
        eq(models.providerId, input.providerId),
        eq(models.modelId, input.modelId),
      ),
    )
    .get();
  if (existing) {
    db.update(models)
      .set({ displayName: input.displayName })
      .where(eq(models.id, existing.id))
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(models)
    .values({ id, ...input })
    .run();
  return id;
}

function upsertSkill(input: {
  name: string;
  description: string;
  content: string;
}): string {
  const existing = db
    .select()
    .from(skills)
    .where(eq(skills.name, input.name))
    .get();
  if (existing) {
    db.update(skills)
      .set({ description: input.description, content: input.content })
      .where(eq(skills.id, existing.id))
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(skills)
    .values({ id, ...input })
    .run();
  return id;
}

function upsertTool(input: {
  name: string;
  description: string;
  code: string;
}): string {
  const existing = db
    .select()
    .from(tools)
    .where(eq(tools.name, input.name))
    .get();
  if (existing) {
    db.update(tools)
      .set({ description: input.description, code: input.code })
      .where(eq(tools.id, existing.id))
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(tools)
    .values({ id, ...input })
    .run();
  return id;
}

interface SeedPort {
  name: string;
  objectTypeId: string;
}

function upsertAction(input: {
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: "low" | "medium" | "high" | "max";
  inputs: SeedPort[];
  outputs: SeedPort[];
  skillIds: string[];
  toolIds: string[];
}): string {
  const values = {
    description: input.description,
    prompt: input.prompt,
    rule: input.rule,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
  };
  const existing = db
    .select()
    .from(actions)
    .where(eq(actions.name, input.name))
    .get();
  let actionId: string;
  if (existing) {
    actionId = existing.id;
    db.update(actions).set(values).where(eq(actions.id, actionId)).run();
  } else {
    actionId = crypto.randomUUID();
    db.insert(actions)
      .values({ id: actionId, name: input.name, ...values })
      .run();
  }

  // 关联表：先删后插
  db.delete(actionPorts).where(eq(actionPorts.actionId, actionId)).run();
  db.delete(actionSkills).where(eq(actionSkills.actionId, actionId)).run();
  db.delete(actionTools).where(eq(actionTools.actionId, actionId)).run();

  input.inputs.forEach((port, i) => {
    db.insert(actionPorts)
      .values({
        id: crypto.randomUUID(),
        actionId,
        direction: "input",
        name: port.name,
        objectTypeId: port.objectTypeId,
        position: i,
      })
      .run();
  });
  input.outputs.forEach((port, i) => {
    db.insert(actionPorts)
      .values({
        id: crypto.randomUUID(),
        actionId,
        direction: "output",
        name: port.name,
        objectTypeId: port.objectTypeId,
        position: i,
      })
      .run();
  });
  input.skillIds.forEach((skillId, i) => {
    db.insert(actionSkills).values({ actionId, skillId, position: i }).run();
  });
  input.toolIds.forEach((toolId) => {
    db.insert(actionTools).values({ actionId, toolId }).run();
  });
  return actionId;
}

function upsertWorkflow(input: { name: string; description: string }): string {
  const existing = db
    .select()
    .from(workflows)
    .where(eq(workflows.name, input.name))
    .get();
  if (existing) {
    db.update(workflows)
      .set({ description: input.description })
      .where(eq(workflows.id, existing.id))
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(workflows)
    .values({ id, ...input })
    .run();
  return id;
}

/** 标签按 name 唯一，已存在则复用（不覆盖用户后来改过的颜色） */
function upsertTag(name: string): string {
  const existing = db.select().from(tags).where(eq(tags.name, name)).get();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.insert(tags).values({ id, name, color: null }).run();
  return id;
}

/** 整体替换某实体的标签集合：先删该实体已有关联再插 */
function assignTags(
  entityKind: EntityKind,
  entityId: string,
  tagIds: string[],
): void {
  db.delete(entityTags)
    .where(
      and(
        eq(entityTags.entityKind, entityKind),
        eq(entityTags.entityId, entityId),
      ),
    )
    .run();
  for (const tagId of Array.from(new Set(tagIds))) {
    db.insert(entityTags).values({ entityKind, entityId, tagId }).run();
  }
}

// ---------------------------------------------------------------------------
// ① 内置 Object Types + ② 案例 Object Types
// ---------------------------------------------------------------------------

const otText = upsertObjectType({
  name: "text",
  kind: "text",
  description: "内置通用文本类型：任意纯文本内容。",
  builtin: true,
});
const otFile = upsertObjectType({
  name: "file",
  kind: "file",
  description: "内置通用文件类型：以文件形式传递的内容（上传或运行产物）。",
  builtin: true,
});
const otJson = upsertObjectType({
  name: "json",
  kind: "json",
  description: "内置通用 JSON 类型：结构化数据，可按需附带 JSON Schema。",
  builtin: true,
});

const otRequirementFile = upsertObjectType({
  name: "需求文件",
  kind: "file",
  description:
    "各需求部门/成员单位提交的原始采购需求文件（txt 等纯文本），按部门罗列物资名称、规格、数量、预算、期望到货时间及口径备注，是整个工作流的唯一事实来源。",
});
const otRequirementPrompt = upsertObjectType({
  name: "需求Prompt",
  kind: "text",
  description:
    "由需求文件整理出的结构化采购需求描述文本：逐行列出需求要素（部门、品目与规格、数量、单位、金额、需求时间），缺失要素标「未提供」，并附口径备注、同类需求归组提示与信息缺口清单，作为集采计划生成的直接输入。",
});
const otPlan = upsertObjectType({
  name: "集采计划",
  kind: "text",
  description:
    "按《集采计划编制规范》编制的集中采购计划 Markdown 全文，含计划概述、需求汇总总览、需求明细与合并结果、品类划分与集采分类、数量与预算口径、时间安排、风险与待确认事项七个章节。",
});
const otReview = upsertObjectType({
  name: "审核评价",
  kind: "json",
  description:
    "按《集采计划审核要点》逐条检查后输出的结构化审核评价：总结论（通过/有保留通过/退回）、总体意见与问题清单。",
  jsonSchema: REVIEW_JSON_SCHEMA,
});
const otReceipt = upsertObjectType({
  name: "归档回执",
  kind: "text",
  description:
    "归档动作的执行回执：入库记录标识、关键字段回显、备份文件路径与归档时间；工具调用失败时如实记录失败原因。",
});

// ---------------------------------------------------------------------------
// ③ Models
// ---------------------------------------------------------------------------

const modelDeepseek = upsertModel({
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
});
upsertModel({
  providerId: "newapi",
  modelId: "openai/gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
});

// ---------------------------------------------------------------------------
// ④ Skills
// ---------------------------------------------------------------------------

const skillBianzhi = upsertSkill({
  name: "集采计划编制规范",
  description:
    "约定集采计划文档的章节结构、需求汇总与合并规则、品类划分、数量与预算口径及时间安排要求的编制规范。",
  content: SKILL_BIANZHI_CONTENT,
});
const skillShenhe = upsertSkill({
  name: "集采计划审核要点",
  description:
    "对集采计划做完整性、口径一致性、合规性与可执行性逐条审核的检查清单与结论规则。",
  content: SKILL_SHENHE_CONTENT,
});

// ---------------------------------------------------------------------------
// ⑤ Tool：save_purchase_plan
// ---------------------------------------------------------------------------

const toolSavePlan = upsertTool({
  name: "save_purchase_plan",
  description:
    "把审核完成的集采计划写入 purchase_plans 表（plan_no 冲突时覆盖），并把计划全文备份为 Markdown 文件，返回入库记录标识与备份路径。",
  code: SAVE_PURCHASE_PLAN_CODE,
});

// ---------------------------------------------------------------------------
// ⑥ Actions
// ---------------------------------------------------------------------------

const actionTidy = upsertAction({
  name: "需求整理",
  description:
    "把原始采购需求文件整理成结构化的需求Prompt：逐行抽取需求要素，标注缺失项并给出同类需求归组提示。",
  prompt: `你收到一份采购需求文件，内容如下：

{{需求文件}}

请把它整理成结构化的采购需求描述（需求Prompt），供后续集采计划生成使用。要求：
1. 逐条列出需求行，每行包含：需求部门/单位、品目名称与规格、数量、计量单位、预估单价或预算金额、期望到货时间；文件中未给出的要素填「未提供」，严禁编造或估算；
2. 保留文件中关于价格口径（如是否含税）、分批交付、统一型号、收货地点、联系人等备注信息，原样归入「备注与口径说明」；
3. 对跨部门的同类物资（品目与规格一致或明显可统一型号）做初步归组提示，只提示、不改动任何原始数据；
4. 输出条理清晰的纯文本：先列需求明细，再列备注与口径说明，然后列同类需求归组提示，最后列信息缺口清单（哪些行缺哪些要素）。`,
  rule: "只做信息抽取、整理与归组提示，不得新增、修改或估算需求文件中不存在的数量、金额与日期；缺失要素一律标注「未提供」。",
  modelId: modelDeepseek,
  reasoningEffort: "low",
  inputs: [{ name: "需求文件", objectTypeId: otRequirementFile }],
  outputs: [{ name: "需求Prompt", objectTypeId: otRequirementPrompt }],
  skillIds: [],
  toolIds: [],
});

const actionGenerate = upsertAction({
  name: "集采计划生成",
  description:
    "依据《集采计划编制规范》，基于整理后的需求Prompt 编制完整的集采计划 Markdown 文档。",
  prompt: `请依据《集采计划编制规范》skill 的要求，基于以下整理后的采购需求，编制一份完整的集采计划文档（Markdown 格式）：

{{需求Prompt}}

要求：
1. 严格按编制规范的七个章节组织文档：计划概述、需求汇总总览、需求明细与合并结果、品类划分与集采分类、数量与预算口径、时间安排、风险与待确认事项；
2. 需求汇总、同类合并、品类划分、数量与预算口径、时间安排全部按规范执行：合并行注明来源与依据，无法确认同一物资的不得合并；
3. 所有数量与金额必须来自需求Prompt 并保持行级可追溯，各级汇总数必须等于明细之和；
4. 需求Prompt 中标注「未提供」或口径不明的信息，在正文对应位置及「风险与待确认事项」章节显式标注「待确认」，不得臆造补齐；集采分类等推断性内容以「建议」标注；
5. 只输出集采计划 Markdown 全文，不要输出与计划无关的说明文字。`,
  rule: "计划中不得出现需求Prompt 之外的数量、金额、日期等关键数值；推断性内容（集采分类建议、统一规格建议）必须以「建议/待确认」标注；汇总数与明细不一致视为不合格产出。",
  modelId: modelDeepseek,
  reasoningEffort: "high",
  inputs: [{ name: "需求Prompt", objectTypeId: otRequirementPrompt }],
  outputs: [{ name: "集采计划", objectTypeId: otPlan }],
  skillIds: [skillBianzhi],
  toolIds: [],
});

const actionReview = upsertAction({
  name: "集采计划审核",
  description:
    "依据《集采计划审核要点》逐条审核集采计划，输出结构化审核评价，并把计划原文原样透传。",
  prompt: `请依据《集采计划审核要点》skill，对下面这份集采计划进行审核：

{{集采计划}}

要求：
1. 逐条执行审核要点清单中的全部检查项，每条给出「通过/不通过/不适用」判定；重点核算汇总数与明细的一致性、合并行的可追溯性；
2. 按审核要点的结论规则给出总结论（通过/有保留通过/退回）；
3. 以约定的 JSON 结构输出审核评价：conclusion（总结论）、summary（总体意见）、issues（问题清单，每条含 checklist_item、category、location、description、suggestion、severity）；无问题时 issues 为空数组；
4. 审核不修改计划正文；集采计划原文经「集采计划」输出端口原样透传，不得增删任何内容。`,
  rule: "只依据审核要点清单作判定，不得改写集采计划正文；总结论必须与问题清单一致——存在数字正确性或完整性不通过项时必须为「退回」，不得降级为通过。",
  modelId: modelDeepseek,
  reasoningEffort: "high",
  inputs: [{ name: "集采计划", objectTypeId: otPlan }],
  outputs: [
    { name: "审核评价", objectTypeId: otReview },
    { name: "集采计划", objectTypeId: otPlan },
  ],
  skillIds: [skillShenhe],
  toolIds: [],
});

const actionArchive = upsertAction({
  name: "集采计划归档",
  description:
    "提取归档字段并调用 save_purchase_plan 工具，把集采计划与审核评价写入 purchase_plans 并生成备份，输出归档回执。",
  prompt: `请把审核完成的集采计划归档入库。

集采计划全文：
{{集采计划}}

审核评价：
{{审核评价}}

请执行：
1. 从集采计划正文提取归档字段：plan_no（计划编号；正文未给出时按「CPP-年度-三位序号」格式生成，并在回执中注明为系统生成）、plan_title（计划标题）、plan_type（集采分类，含「待确认」时如实保留）、plan_year（计划年度/周期）、org_units（涉及部门/单位，逗号分隔）、category_summary（品类划分摘要）、item_count（合并后明细行数）、total_budget（预算总额，数值，单位元）、budget_note（预算与价格口径说明）、schedule_summary（时间安排摘要）、pending_issues（待确认事项摘要）；
2. 从审核评价提取 review_conclusion（总结论），review_feedback 存审核评价 JSON 全文，plan_content 存集采计划 Markdown 全文；
3. 调用 save_purchase_plan 工具，把上述字段写入 purchase_plans 表；
4. 将集采计划全文另存一份 Markdown 备份文件，文件名包含计划编号与归档日期，并把备份文件路径记入 backup_path；
5. 输出归档回执：入库记录标识、关键字段回显、备份文件路径、归档时间。若工具调用或写备份失败，在回执中如实说明失败环节与原因，不得声称成功。`,
  rule: "归档结果必须以 save_purchase_plan 工具的真实返回为准，未成功调用不得声称已入库；提取字段与计划正文不一致时以正文为准；集采计划与审核评价全文必须原样入库，不得节选。",
  modelId: modelDeepseek,
  reasoningEffort: "low",
  inputs: [
    { name: "集采计划", objectTypeId: otPlan },
    { name: "审核评价", objectTypeId: otReview },
  ],
  outputs: [{ name: "归档回执", objectTypeId: otReceipt }],
  skillIds: [],
  toolIds: [toolSavePlan],
});

// ---------------------------------------------------------------------------
// ⑦ Workflow「采购集采计划生成」
// ---------------------------------------------------------------------------

const workflowId = upsertWorkflow({
  name: "采购集采计划生成",
  description:
    "输入原始采购需求文件，依次完成需求整理、集采计划生成与审核，审核评价直接输出，同时归档入库并输出归档回执。",
});

// 图整体重建：先删连线再删节点（节点 id 每次重建，画布保存时同样由前端整图替换）
db.delete(workflowEdges).where(eq(workflowEdges.workflowId, workflowId)).run();
db.delete(workflowNodes).where(eq(workflowNodes.workflowId, workflowId)).run();

const nodeInput = crypto.randomUUID();
const nodeTidy = crypto.randomUUID();
const nodeGenerate = crypto.randomUUID();
const nodeReview = crypto.randomUUID();
const nodeOutputReview = crypto.randomUUID();
const nodeArchive = crypto.randomUUID();
const nodeOutputReceipt = crypto.randomUUID();

const seedNodes: (typeof workflowNodes.$inferInsert)[] = [
  {
    id: nodeInput,
    workflowId,
    kind: "input",
    actionId: null,
    objectTypeId: otRequirementFile,
    label: "需求文件",
    x: 0,
    y: 240,
  },
  {
    id: nodeTidy,
    workflowId,
    kind: "action",
    actionId: actionTidy,
    objectTypeId: null,
    label: "需求整理",
    x: 320,
    y: 200,
  },
  {
    id: nodeGenerate,
    workflowId,
    kind: "action",
    actionId: actionGenerate,
    objectTypeId: null,
    label: "集采计划生成",
    x: 640,
    y: 240,
  },
  {
    id: nodeReview,
    workflowId,
    kind: "action",
    actionId: actionReview,
    objectTypeId: null,
    label: "集采计划审核",
    x: 960,
    y: 200,
  },
  {
    id: nodeOutputReview,
    workflowId,
    kind: "output",
    actionId: null,
    objectTypeId: otReview,
    label: "审核评价",
    x: 1280,
    y: 40,
  },
  {
    id: nodeArchive,
    workflowId,
    kind: "action",
    actionId: actionArchive,
    objectTypeId: null,
    label: "集采计划归档",
    x: 1280,
    y: 320,
  },
  {
    id: nodeOutputReceipt,
    workflowId,
    kind: "output",
    actionId: null,
    objectTypeId: otReceipt,
    label: "归档回执",
    x: 1600,
    y: 280,
  },
];
for (const node of seedNodes) {
  db.insert(workflowNodes).values(node).run();
}

const seedEdges: (typeof workflowEdges.$inferInsert)[] = [
  {
    id: crypto.randomUUID(),
    workflowId,
    sourceNodeId: nodeInput,
    sourcePort: "value",
    targetNodeId: nodeTidy,
    targetPort: "需求文件",
  },
  {
    id: crypto.randomUUID(),
    workflowId,
    sourceNodeId: nodeTidy,
    sourcePort: "需求Prompt",
    targetNodeId: nodeGenerate,
    targetPort: "需求Prompt",
  },
  {
    id: crypto.randomUUID(),
    workflowId,
    sourceNodeId: nodeGenerate,
    sourcePort: "集采计划",
    targetNodeId: nodeReview,
    targetPort: "集采计划",
  },
  {
    id: crypto.randomUUID(),
    workflowId,
    sourceNodeId: nodeReview,
    sourcePort: "审核评价",
    targetNodeId: nodeOutputReview,
    targetPort: "value",
  },
  {
    id: crypto.randomUUID(),
    workflowId,
    sourceNodeId: nodeReview,
    sourcePort: "审核评价",
    targetNodeId: nodeArchive,
    targetPort: "审核评价",
  },
  {
    id: crypto.randomUUID(),
    workflowId,
    sourceNodeId: nodeReview,
    sourcePort: "集采计划",
    targetNodeId: nodeArchive,
    targetPort: "集采计划",
  },
  {
    id: crypto.randomUUID(),
    workflowId,
    sourceNodeId: nodeArchive,
    sourcePort: "归档回执",
    targetNodeId: nodeOutputReceipt,
    targetPort: "value",
  },
];
for (const edge of seedEdges) {
  db.insert(workflowEdges).values(edge).run();
}

// ---------------------------------------------------------------------------
// ⑧ 标签体系（ADR-0003：多归属标签，`/` 表达层级，由前端拆成树）
// ---------------------------------------------------------------------------

const SEED_TAG_NAMES = [
  "采购/集采",
  "采购/需求",
  "能力/整理",
  "能力/生成",
  "能力/审核",
  "能力/归档",
  "类型/业务对象",
  "类型/通用",
  "状态/已验证",
] as const;
type SeedTagName = (typeof SEED_TAG_NAMES)[number];

const seedTagIds = new Map<string, string>(
  SEED_TAG_NAMES.map((name) => [name, upsertTag(name)]),
);

function tag(name: SeedTagName): string {
  const id = seedTagIds.get(name);
  if (!id) throw new Error(`标签未创建：${name}`);
  return id;
}

assignTags("workflow", workflowId, [tag("采购/集采"), tag("状态/已验证")]);

assignTags("action", actionTidy, [tag("采购/需求"), tag("能力/整理")]);
assignTags("action", actionGenerate, [tag("采购/集采"), tag("能力/生成")]);
assignTags("action", actionReview, [tag("采购/集采"), tag("能力/审核")]);
assignTags("action", actionArchive, [tag("采购/集采"), tag("能力/归档")]);

assignTags("skill", skillBianzhi, [tag("采购/集采"), tag("能力/生成")]);
assignTags("skill", skillShenhe, [tag("采购/集采"), tag("能力/审核")]);

assignTags("tool", toolSavePlan, [tag("采购/集采"), tag("能力/归档")]);

assignTags("object_type", otRequirementFile, [tag("类型/业务对象")]);
assignTags("object_type", otRequirementPrompt, [tag("类型/业务对象")]);
assignTags("object_type", otPlan, [tag("类型/业务对象"), tag("采购/集采")]);
assignTags("object_type", otReview, [tag("类型/业务对象"), tag("采购/集采")]);
assignTags("object_type", otReceipt, [tag("类型/业务对象")]);
assignTags("object_type", otText, [tag("类型/通用")]);
assignTags("object_type", otFile, [tag("类型/通用")]);
assignTags("object_type", otJson, [tag("类型/通用")]);

// ---------------------------------------------------------------------------
// ⑨ 种子实体的第 1 版修订
// ---------------------------------------------------------------------------

/**
 * 从库里回读实体的完整定义作为修订 payload——形状与各库 PUT 载荷一致
 * （DESIGN.md「API 面」：Action 含 ports/skillIds/toolIds，Workflow 含 nodes/edges），
 * 保证回滚能走与 PUT 相同的写入路径。
 */
function entityPayload(kind: EntityKind, id: string): Record<string, unknown> {
  switch (kind) {
    case "object_type": {
      const row = db
        .select()
        .from(objectTypes)
        .where(eq(objectTypes.id, id))
        .get();
      if (!row) throw new Error(`对象类型不存在：${id}`);
      return {
        name: row.name,
        kind: row.kind,
        description: row.description,
        jsonSchema: row.jsonSchema,
        builtin: row.builtin,
      };
    }
    case "skill": {
      const row = db.select().from(skills).where(eq(skills.id, id)).get();
      if (!row) throw new Error(`技能不存在：${id}`);
      return {
        name: row.name,
        description: row.description,
        content: row.content,
      };
    }
    case "tool": {
      const row = db.select().from(tools).where(eq(tools.id, id)).get();
      if (!row) throw new Error(`工具不存在：${id}`);
      return {
        name: row.name,
        description: row.description,
        code: row.code,
      };
    }
    case "action": {
      const row = db.select().from(actions).where(eq(actions.id, id)).get();
      if (!row) throw new Error(`动作不存在：${id}`);
      const ports = db
        .select()
        .from(actionPorts)
        .where(eq(actionPorts.actionId, id))
        .orderBy(asc(actionPorts.direction), asc(actionPorts.position))
        .all();
      const skillLinks = db
        .select()
        .from(actionSkills)
        .where(eq(actionSkills.actionId, id))
        .orderBy(asc(actionSkills.position))
        .all();
      const toolLinks = db
        .select()
        .from(actionTools)
        .where(eq(actionTools.actionId, id))
        .all();
      return {
        name: row.name,
        description: row.description,
        prompt: row.prompt,
        rule: row.rule,
        modelId: row.modelId,
        reasoningEffort: row.reasoningEffort,
        ports: ports.map((p) => ({
          direction: p.direction,
          name: p.name,
          objectTypeId: p.objectTypeId,
          position: p.position,
        })),
        skillIds: skillLinks.map((s) => s.skillId),
        toolIds: toolLinks.map((t) => t.toolId),
      };
    }
    case "workflow": {
      const row = db.select().from(workflows).where(eq(workflows.id, id)).get();
      if (!row) throw new Error(`工作流不存在：${id}`);
      const nodes = db
        .select()
        .from(workflowNodes)
        .where(eq(workflowNodes.workflowId, id))
        .all();
      const edges = db
        .select()
        .from(workflowEdges)
        .where(eq(workflowEdges.workflowId, id))
        .all();
      return {
        name: row.name,
        description: row.description,
        nodes: nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          actionId: n.actionId,
          objectTypeId: n.objectTypeId,
          label: n.label,
          x: n.x,
          y: n.y,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          sourceNodeId: e.sourceNodeId,
          sourcePort: e.sourcePort,
          targetNodeId: e.targetNodeId,
          targetPort: e.targetPort,
        })),
      };
    }
  }
}

/** 幂等：该实体已有任何修订就跳过，只为首次播种补第 1 版 */
async function seedRevision(kind: EntityKind, id: string): Promise<boolean> {
  const existing = db
    .select()
    .from(revisions)
    .where(and(eq(revisions.entityKind, kind), eq(revisions.entityId, id)))
    .get();
  if (existing) return false;
  recordRevision(kind, id, entityPayload(kind, id), "种子初始版本");
  return true;
}

const seedEntities: Array<{ kind: EntityKind; id: string }> = [
  { kind: "object_type", id: otText },
  { kind: "object_type", id: otFile },
  { kind: "object_type", id: otJson },
  { kind: "object_type", id: otRequirementFile },
  { kind: "object_type", id: otRequirementPrompt },
  { kind: "object_type", id: otPlan },
  { kind: "object_type", id: otReview },
  { kind: "object_type", id: otReceipt },
  { kind: "skill", id: skillBianzhi },
  { kind: "skill", id: skillShenhe },
  { kind: "tool", id: toolSavePlan },
  { kind: "action", id: actionTidy },
  { kind: "action", id: actionGenerate },
  { kind: "action", id: actionReview },
  { kind: "action", id: actionArchive },
  { kind: "workflow", id: workflowId },
];

let newRevisions = 0;
for (const entity of seedEntities) {
  if (await seedRevision(entity.kind, entity.id)) newRevisions += 1;
}

// ---------------------------------------------------------------------------
// ⑩ 示例需求文件
// ---------------------------------------------------------------------------

const samplesDir = path.join(process.cwd(), "data", "samples");
fs.mkdirSync(samplesDir, { recursive: true });
const samplePath = path.join(samplesDir, "采购需求示例.txt");
fs.writeFileSync(samplePath, SAMPLE_REQUIREMENT_TXT, "utf8");

// ---------------------------------------------------------------------------
// 计数汇总
// ---------------------------------------------------------------------------

const counts = {
  对象类型: db.select().from(objectTypes).all().length,
  模型: db.select().from(models).all().length,
  技能: db.select().from(skills).all().length,
  工具: db.select().from(tools).all().length,
  动作: db.select().from(actions).all().length,
  动作端口: db.select().from(actionPorts).all().length,
  动作技能关联: db.select().from(actionSkills).all().length,
  动作工具关联: db.select().from(actionTools).all().length,
  工作流: db.select().from(workflows).all().length,
  工作流节点: db.select().from(workflowNodes).all().length,
  工作流连线: db.select().from(workflowEdges).all().length,
  标签: db.select().from(tags).all().length,
  标签关联: db.select().from(entityTags).all().length,
  修订: db.select().from(revisions).all().length,
};

console.log("种子写入完成：");
for (const [name, count] of Object.entries(counts)) {
  console.log(`  ${name}: ${count}`);
}
console.log(`  本次新增修订: ${newRevisions}`);
console.log(`  示例需求文件: ${samplePath}`);
