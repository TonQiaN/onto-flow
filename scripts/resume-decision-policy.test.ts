/**
 * 「简历匹配评分」种子里两类 sha256 re-pin 管不到的东西。
 *
 * 三类摘要 pin（工作流行为、八个 Action 行为、校验 Tool 契约，都在 `src/lib/resume-match.ts`）
 * 只在**值变了**时红，而 re-pin 是一次显式审阅步骤——审阅者更新 pin 时裁决语义被悄悄删掉一句
 * 不会有人红。三类摘要也完全不含图的连通性：种子到底把六位评委接到汇总没有，
 * `validateWorkflowContract` 只对**受理时那张运行图**查，`src/server/resume-match.test.ts`
 * 又只拿自造的错图验拒绝逻辑，从不评估种子造出来的图。这个文件补的就是这两处：
 *
 * 1. 裁决语义短语——评委与汇总的 prompt / rule 里那几句「不得生成面试问题」「未证实不等于不具备」；
 * 2. 种子实际接线——边集合与八个 Action 的端口集合，跟受理时用的**同一份**期望做精确比较。
 *
 * 校验 Tool 的实现细节不归这里：`RESUME_MATCH_VALIDATOR_TOOL_SHA256` 把整段 `code` 逐字盖住了。
 * 拓扑用例读的是 `scripts/seed-resume-graph.ts` 导出的**数据**而不是种子脚本的源码文本，
 * 所以换个变量名、换行或挪个布局坐标都不会红，多一条边或少一条边一定红。
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RESUME_MATCH_CRITIC_ACTION_NAMES,
  RESUME_MATCH_JOB_INPUT_LABEL,
  RESUME_MATCH_OUTPUT_LABEL,
  RESUME_MATCH_RESUME_INPUT_LABEL,
  resumeMatchEdgeKeys,
  resumeMatchExpectedEdges,
  resumeMatchExpectedPorts,
  type ResumeMatchPortContract,
} from "../src/lib/resume-match";
import { resumeMatchSeedGraph, resumeMatchSeedPorts } from "./seed-resume-graph";

const source = fs.readFileSync(new URL("./seed-resume.ts", import.meta.url), "utf8");
const graphSource = fs.readFileSync(new URL("./seed-resume-graph.ts", import.meta.url), "utf8");
/** 语义短语按「种子里有没有这句话」判，评委口径搬进哪个文件不该让它红。 */
const seedText = `${source}\n${graphSource}`;

/** 可读的假 id：断言失败时能一眼看出是哪个节点、哪个对象类型错了。 */
const TYPES = {
  jobFile: "type-岗位JD文件",
  resumeFile: "type-简历文件",
  parsedJob: "type-岗位要求Markdown",
  parsedResume: "type-简历Markdown",
  criticResult: "type-评委结论",
  result: "type-评分报告",
};
const ACTION_IDS = {
  parse: "action-解析",
  critics: RESUME_MATCH_CRITIC_ACTION_NAMES.map((name) => `action-${name}`),
  report: "action-汇总",
};

const seedGraph = resumeMatchSeedGraph({ types: TYPES, actionIds: ACTION_IDS });
const seedPorts = resumeMatchSeedPorts(TYPES);

/** 端口比名字、对象类型与产物路径；值类型由对象类型决定，受理时另有一层校验。 */
function portKeys(
  ports: readonly { name: string; objectTypeId: string; artifactPath?: string }[],
): string[] {
  return ports.map((port) => `${port.name}|${port.objectTypeId}|${port.artifactPath ?? ""}`).sort();
}

function expectedPortKeys(ports: readonly ResumeMatchPortContract[]): string[] {
  return ports.map((port) => `${port.name}|${port.objectTypeId}|${port.artifactPath ?? ""}`).sort();
}

describe("简历评分闭环裁决契约", () => {
  it("明确禁止把证据缺口或评委分歧交给后续人工流程", () => {
    expect(seedText).not.toContain("## 面试提问");
    expect(seedText).not.toContain("## 待确认");
    expect(seedText).not.toContain("不重新评分");
    expect(seedText).not.toContain("不推翻单维结论");
    expect(seedText).toContain("不得生成面试问题、人工复核、后续核实或交给他人判断等行动项");
    expect(seedText).toContain("本维度判断必须在当前材料内完成");
  });

  it("要求评委处理证据缺口，最终汇总输出严格 JSON 并完成机械校验", () => {
    expect(seedText).toContain("## 证据缺口及计分处理");
    expect(seedText).toContain("RESUME_MATCH_RESULT_SCHEMA_TEXT");
    expect(seedText).toContain("match-result.json");
    expect(seedText).toContain("RESUME_MATCH_VALIDATOR_TOOL_NAME");
    expect(seedText).toContain("没有拿到 `valid=true` 不得提交结构化输出");
    expect(seedText).toContain("结果不得保留未裁决项");
    expect(source).toMatch(/toolIds: \[validateResultTool\]/);
  });

  it("把未证实保留为事实状态，同时固定其评分影响", () => {
    expect(seedText).toContain("未证实不等于不具备");
    expect(seedText).toContain("只有每一条硬性条件都有明确证据满足才记 100");
    expect(seedText).toContain("未证实项不得写成候选人不具备");
    expect(seedText).toContain("材料未说明原因绝不影响分数");
    expect(seedText).toContain("未证实时写「无」");
  });
});

describe("简历评分种子的实际接线", () => {
  it("节点集合恰好是两个输入、解析、六位评委、汇总与一个输出", () => {
    const key = (node: { kind: string; label: string; actionId: string | null }) =>
      `${node.kind}|${node.label}|${node.actionId ?? ""}`;
    expect(seedGraph.nodes.map(key).sort()).toEqual(
      [
        `input|${RESUME_MATCH_JOB_INPUT_LABEL}|`,
        `input|${RESUME_MATCH_RESUME_INPUT_LABEL}|`,
        `action|解析|${ACTION_IDS.parse}`,
        ...RESUME_MATCH_CRITIC_ACTION_NAMES.map(
          (name, index) => `action|${name.replace("简历评分·", "")}|${ACTION_IDS.critics[index]}`,
        ),
        `action|汇总|${ACTION_IDS.report}`,
        `output|${RESUME_MATCH_OUTPUT_LABEL}|`,
      ].sort(),
    );
  });

  it("边集合与受理时要求的固定编排完全一致：少一条结论边或多一条合法边都红", () => {
    const actual = resumeMatchEdgeKeys(
      seedGraph.edges.map(
        (edge) => [edge.sourceNodeId, edge.sourcePort, edge.targetNodeId, edge.targetPort] as const,
      ),
    );
    expect(actual).toEqual(resumeMatchEdgeKeys(resumeMatchExpectedEdges(seedGraph.roles)));
  });

  it("八个 Action 的端口集合与受理时要求的完整契约完全一致", () => {
    const expected = resumeMatchExpectedPorts(TYPES);
    expect(portKeys(seedPorts.parse.inputs)).toEqual(expectedPortKeys(expected.parse.inputs));
    expect(portKeys(seedPorts.parse.outputs)).toEqual(expectedPortKeys(expected.parse.outputs));
    seedPorts.critics.forEach((critic, index) => {
      expect(portKeys(critic.inputs), RESUME_MATCH_CRITIC_ACTION_NAMES[index]).toEqual(
        expectedPortKeys(expected.critics[index].inputs),
      );
      expect(portKeys(critic.outputs), RESUME_MATCH_CRITIC_ACTION_NAMES[index]).toEqual(
        expectedPortKeys(expected.critics[index].outputs),
      );
    });
    expect(portKeys(seedPorts.report.inputs)).toEqual(expectedPortKeys(expected.report.inputs));
    expect(portKeys(seedPorts.report.outputs)).toEqual(expectedPortKeys(expected.report.outputs));
  });

  it("图定义模块保持无副作用：不碰数据库，也不碰文件系统", () => {
    expect(graphSource).not.toMatch(/from\s+"(?:\.\.\/src\/db|@\/db)"/);
    expect(graphSource).not.toMatch(/from\s+"node:(?:fs|fs\/promises|child_process)"/);
  });
});
