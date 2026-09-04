/**
 * 「简历匹配评分」种子的图定义：六位评委的口径、八个 Action 的端口、工作流的节点与边。
 *
 * 这份文件必须保持**无副作用**——不 import `@/db`、不读写文件系统、模块加载只求值常量。
 * 唯一的运行时依赖是 `crypto.randomUUID()`。`scripts/resume-decision-policy.test.ts` 直接
 * import 它，把种子实际接出来的边与端口跟 `src/lib/resume-match.ts` 里受理时用的期望集合
 * 做精确比较；`seed-resume.ts` 是它唯一的生产消费者，从这里取同一份定义去写库。
 * 把它跟 `seed-resume.ts` 分开，是为了让那条断言读的是**数据**而不是种子脚本的源码文本。
 */
// 类型来自写入器，只做 import type（会被 TS 擦除），本模块运行时仍然碰不到 @/db。
import type { EdgePayload, NodePayload } from "../src/server/writers/workflow";
import {
  RESUME_MATCH_CRITIC_ACTION_NAMES,
  RESUME_MATCH_CRITIC_ARTIFACTS,
  RESUME_MATCH_CRITIC_RESULT_PORT,
  RESUME_MATCH_JOB_INPUT_LABEL,
  RESUME_MATCH_JOB_PARSE_PORT,
  RESUME_MATCH_OUTPUT_LABEL,
  RESUME_MATCH_PARSED_JOB_ARTIFACT,
  RESUME_MATCH_PARSED_JOB_PORT,
  RESUME_MATCH_PARSED_RESUME_ARTIFACT,
  RESUME_MATCH_PARSED_RESUME_PORT,
  RESUME_MATCH_REPORT_CRITICS_PORT,
  RESUME_MATCH_REPORT_RESULT_PORT,
  RESUME_MATCH_RESULT_ARTIFACT,
  RESUME_MATCH_RESUME_INPUT_LABEL,
  RESUME_MATCH_RESUME_PARSE_PORT,
} from "../src/lib/resume-match";

/** Action 的一个端口：类型由对象类型决定，产物路径只有输出端口有。 */
export interface SeedPortSpec {
  name: string;
  objectTypeId: string;
  artifactPath?: string;
}

/** 种子为这条工作流建的六个对象类型的 id。 */
export interface SeedObjectTypeIds {
  jobFile: string;
  resumeFile: string;
  parsedJob: string;
  parsedResume: string;
  criticResult: string;
  result: string;
}

/** 八个 Action 的 id（六位评委按 RESUME_MATCH_CRITIC_ACTION_NAMES 的顺序）。 */
export interface SeedActionIds {
  parse: string;
  critics: readonly string[];
  report: string;
}

export interface SeedActionPorts {
  inputs: SeedPortSpec[];
  outputs: SeedPortSpec[];
}

/** 六个评委：同一套输入输出形状，只有职责与评分口径不同。 */
export const CRITICS: Array<{ key: string; name: string; focus: string; scoring: string }> = [
  {
    key: "must-have",
    name: RESUME_MATCH_CRITIC_ACTION_NAMES[0],
    focus:
      "逐条核对岗位要求里「硬性条件」的每一项：简历中有明确证据满足记「满足」，" +
      "明确不满足记「不满足」，没写记「未证实」，材料内部相互矛盾记「材料冲突」。" +
      "未证实不等于候选人不具备，只表示当前材料没有达到硬性条件的证据门槛。",
    scoring:
      "本维度是否决维度，分数只取 0 或 100：只有每一条硬性条件都有明确证据满足才记 100；" +
      "任一条不满足、未证实或材料冲突都记 0，并分别写明是事实不满足，还是当前材料未能证实。",
  },
  {
    key: "skill-match",
    name: RESUME_MATCH_CRITIC_ACTION_NAMES[1],
    focus:
      "把岗位要求里的技能项逐个在简历里查证，分三档：直接命中（写明用过并有具体场景）、" +
      "间接命中（相近技术栈，必须说明相近在哪）、未证实。只出现在技能清单、" +
      "正文经历里找不到对应场景的，记为「仅列举」，不算直接命中。",
    scoring: "按命中比例与该技能对岗位的关键程度加权，不按简历罗列的技能总数。",
  },
  {
    key: "experience-depth",
    name: RESUME_MATCH_CRITIC_ACTION_NAMES[2],
    focus:
      "看职责层级、独立度、项目规模与复杂度，不看年限数字。区分「参与」「负责」「主导」，" +
      "区分课程或个人项目与生产系统。",
    scoring:
      "并发量、数据量、团队人数这类可核查的量化描述是加分依据；没有量化描述时按证据不足处理，不按经验不足处理。",
  },
  {
    key: "domain-fit",
    name: RESUME_MATCH_CRITIC_ACTION_NAMES[3],
    focus: "判断过往的行业、业务场景与客户类型能否接上本岗位。",
    scoring:
      "跨行但底层问题同构时（例如同为高并发交易系统），明确写出同构点，不因行业名称不同直接扣分。",
  },
  {
    key: "stability",
    name: RESUME_MATCH_CRITIC_ACTION_NAMES[4],
    focus: "逐段核对起止时间与在职时长，只判断简历明示的时间线是否完整、自洽和可计算。",
    scoring:
      "只对缺少起止日期、日期前后矛盾等时间线质量问题计分。空窗、转行与短期任职本身不扣分，也不推测原因；" +
      "材料未说明原因绝不影响分数，只记为与岗位匹配无关的未知事实；" +
      "求学、服役、育儿、照护、健康或创业等经历不得成为扣分依据。",
  },
  {
    key: "red-flag",
    name: RESUME_MATCH_CRITIC_ACTION_NAMES[5],
    focus:
      "只找同一份简历中可直接定位、对同一事实作出互相矛盾陈述的问题，例如同一经历的起止日期前后不一致，" +
      "或同一项目的职责、成果与可复算数字在不同段落互相否定。",
    scoring:
      "不得基于外部世界知识断言真伪。本维度是否决维度，分数只取 0 或 100：" +
      "只有材料内部可直接证明、且足以改变岗位匹配判断的重大事实矛盾才记 0。" +
      "时间段重叠、职级与年限关系、快速晋升、绝对化措辞、模板化表达、模糊、缺失或外部无法验证本身都不构成造假证据。" +
      "没有发现足以否决的内部证据时明确写「未发现」并记 100。",
  },
];

/**
 * 八个 Action 的完整端口集合。受理时 `validateWorkflowContract` 会拿
 * `resumeMatchExpectedPorts()` 逐个 Action 做**精确**比较，多一个端口就 422，
 * 所以这份定义与那份期望必须一致。
 */
export function resumeMatchSeedPorts(types: SeedObjectTypeIds): {
  parse: SeedActionPorts;
  critics: SeedActionPorts[];
  report: SeedActionPorts;
} {
  return {
    parse: {
      inputs: [
        { name: RESUME_MATCH_JOB_PARSE_PORT, objectTypeId: types.jobFile },
        { name: RESUME_MATCH_RESUME_PARSE_PORT, objectTypeId: types.resumeFile },
      ],
      outputs: [
        {
          name: RESUME_MATCH_PARSED_JOB_PORT,
          objectTypeId: types.parsedJob,
          artifactPath: RESUME_MATCH_PARSED_JOB_ARTIFACT,
        },
        {
          name: RESUME_MATCH_PARSED_RESUME_PORT,
          objectTypeId: types.parsedResume,
          artifactPath: RESUME_MATCH_PARSED_RESUME_ARTIFACT,
        },
      ],
    },
    critics: CRITICS.map((_critic, index) => ({
      inputs: [
        { name: RESUME_MATCH_PARSED_JOB_PORT, objectTypeId: types.parsedJob },
        { name: RESUME_MATCH_PARSED_RESUME_PORT, objectTypeId: types.parsedResume },
      ],
      outputs: [
        {
          name: RESUME_MATCH_CRITIC_RESULT_PORT,
          objectTypeId: types.criticResult,
          artifactPath: RESUME_MATCH_CRITIC_ARTIFACTS[index],
        },
      ],
    })),
    report: {
      inputs: [
        { name: RESUME_MATCH_PARSED_JOB_PORT, objectTypeId: types.parsedJob },
        { name: RESUME_MATCH_PARSED_RESUME_PORT, objectTypeId: types.parsedResume },
        { name: RESUME_MATCH_REPORT_CRITICS_PORT, objectTypeId: types.criticResult },
      ],
      outputs: [
        {
          name: RESUME_MATCH_REPORT_RESULT_PORT,
          objectTypeId: types.result,
          artifactPath: RESUME_MATCH_RESULT_ARTIFACT,
        },
      ],
    },
  };
}

/** 库里已有的节点行：只要认形状用的那几列，用来复用 id 保持幂等。 */
export interface ExistingNodeRow {
  id: string;
  kind: string;
  actionId: string | null;
  objectTypeId: string | null;
  label: string;
}

/** 库里已有的边行：同样只要认形状用的那四列。 */
export interface ExistingEdgeRow {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

/** 图里每个角色对应的节点 id，供调用方（与测试）按角色寻址而不是猜标签。 */
export interface SeedGraphRoles {
  job: string;
  resume: string;
  parse: string;
  critics: string[];
  report: string;
  output: string;
}

export interface SeedGraph {
  nodes: NodePayload[];
  edges: EdgePayload[];
  roles: SeedGraphRoles;
}

/**
 * 两个输入 → 解析 → 六个评委静态扇出 → 汇总 → 输出。
 *
 * 扇出是图的形状而不是节点类型（ADR-0009）：解析的两个输出端口各连到六个评委；汇总另各接一条
 * 岗位与简历原文边，并在一个结论端口接齐六份评委产物（同一端口的多条入边要全部结算才就绪）。
 *
 * `currentNodes` / `currentEdges` 是库里已有的行，形状对得上就复用它的 id——幂等靠这个，
 * 不传就全部新建。除此之外本函数不看外界任何状态。
 */
export function resumeMatchSeedGraph(input: {
  types: SeedObjectTypeIds;
  actionIds: SeedActionIds;
  currentNodes?: readonly ExistingNodeRow[];
  currentEdges?: readonly ExistingEdgeRow[];
}): SeedGraph {
  const { types, actionIds } = input;
  const currentNodes = input.currentNodes ?? [];
  const currentEdges = input.currentEdges ?? [];

  const unusedNodeIds = new Set(currentNodes.map((node) => node.id));
  function nodeId(shape: Omit<NodePayload, "id" | "x" | "y">): string {
    const found = currentNodes.find(
      (node) =>
        unusedNodeIds.has(node.id) &&
        node.kind === shape.kind &&
        node.actionId === shape.actionId &&
        node.objectTypeId === shape.objectTypeId &&
        node.label === shape.label,
    );
    if (!found) return crypto.randomUUID();
    unusedNodeIds.delete(found.id);
    return found.id;
  }

  function inputNode(label: string, objectTypeId: string, x: number, y: number): NodePayload {
    const shape = { kind: "input" as const, actionId: null, objectTypeId, label };
    return { id: nodeId(shape), ...shape, x, y };
  }

  function actionNode(label: string, actionId: string, x: number, y: number): NodePayload {
    const shape = { kind: "action" as const, actionId, objectTypeId: null, label };
    return { id: nodeId(shape), ...shape, x, y };
  }

  function outputNode(label: string, objectTypeId: string, x: number, y: number): NodePayload {
    const shape = { kind: "output" as const, actionId: null, objectTypeId, label };
    return { id: nodeId(shape), ...shape, x, y };
  }

  const jdNode = inputNode(RESUME_MATCH_JOB_INPUT_LABEL, types.jobFile, 0, 80);
  const resumeNode = inputNode(RESUME_MATCH_RESUME_INPUT_LABEL, types.resumeFile, 0, 260);
  const parseNode = actionNode("解析", actionIds.parse, 260, 170);
  const criticNodes = CRITICS.map((critic, index) =>
    actionNode(critic.name.replace("简历评分·", ""), actionIds.critics[index], 540, index * 110),
  );
  const reportNode = actionNode("汇总", actionIds.report, 820, 280);
  const outNode = outputNode(RESUME_MATCH_OUTPUT_LABEL, types.result, 1080, 280);
  const nodes = [jdNode, resumeNode, parseNode, ...criticNodes, reportNode, outNode];

  const unusedEdgeIds = new Set(currentEdges.map((edge) => edge.id));
  function edgeId(shape: Omit<EdgePayload, "id">): string {
    const found = currentEdges.find(
      (edge) =>
        unusedEdgeIds.has(edge.id) &&
        edge.sourceNodeId === shape.sourceNodeId &&
        edge.sourcePort === shape.sourcePort &&
        edge.targetNodeId === shape.targetNodeId &&
        edge.targetPort === shape.targetPort,
    );
    if (!found) return crypto.randomUUID();
    unusedEdgeIds.delete(found.id);
    return found.id;
  }

  function edge(shape: Omit<EdgePayload, "id">): EdgePayload {
    return { id: edgeId(shape), ...shape };
  }

  const edges = [
    edge({
      sourceNodeId: jdNode.id,
      sourcePort: "value",
      targetNodeId: parseNode.id,
      targetPort: RESUME_MATCH_JOB_PARSE_PORT,
    }),
    edge({
      sourceNodeId: resumeNode.id,
      sourcePort: "value",
      targetNodeId: parseNode.id,
      targetPort: RESUME_MATCH_RESUME_PARSE_PORT,
    }),
    // 扇出：解析的两个输出端口各连出六条线，六个评委并行跑
    ...criticNodes.flatMap((criticNode) => [
      edge({
        sourceNodeId: parseNode.id,
        sourcePort: RESUME_MATCH_PARSED_JOB_PORT,
        targetNodeId: criticNode.id,
        targetPort: RESUME_MATCH_PARSED_JOB_PORT,
      }),
      edge({
        sourceNodeId: parseNode.id,
        sourcePort: RESUME_MATCH_PARSED_RESUME_PORT,
        targetNodeId: criticNode.id,
        targetPort: RESUME_MATCH_PARSED_RESUME_PORT,
      }),
    ]),
    // 最终汇总回看岗位与简历原文，再读齐六份评委结论完成裁决。
    edge({
      sourceNodeId: parseNode.id,
      sourcePort: RESUME_MATCH_PARSED_JOB_PORT,
      targetNodeId: reportNode.id,
      targetPort: RESUME_MATCH_PARSED_JOB_PORT,
    }),
    edge({
      sourceNodeId: parseNode.id,
      sourcePort: RESUME_MATCH_PARSED_RESUME_PORT,
      targetNodeId: reportNode.id,
      targetPort: RESUME_MATCH_PARSED_RESUME_PORT,
    }),
    // 一个评委结论输入端口接进六条线，节点会等待全部结算。
    ...criticNodes.map((criticNode) =>
      edge({
        sourceNodeId: criticNode.id,
        sourcePort: RESUME_MATCH_CRITIC_RESULT_PORT,
        targetNodeId: reportNode.id,
        targetPort: RESUME_MATCH_REPORT_CRITICS_PORT,
      }),
    ),
    edge({
      sourceNodeId: reportNode.id,
      sourcePort: RESUME_MATCH_REPORT_RESULT_PORT,
      targetNodeId: outNode.id,
      targetPort: "value",
    }),
  ];

  return {
    nodes,
    edges,
    roles: {
      job: jdNode.id,
      resume: resumeNode.id,
      parse: parseNode.id,
      critics: criticNodes.map((node) => node.id),
      report: reportNode.id,
      output: outNode.id,
    },
  };
}
