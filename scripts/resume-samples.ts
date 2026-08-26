import fs from "node:fs";
import { resolveWithinData } from "../src/server/fs-safety";

const SAMPLE_JOB = `# 虚构岗位样例（不对应真实职位）

## 岗位概要

负责企业内部工作流平台的服务端开发与运行稳定性。

## 硬性条件

- 三年以上 TypeScript 或 Node.js 生产系统经验
- 熟悉 SQL 数据库与事务
- 能用中文进行书面协作

## 技能要求

- TypeScript、Node.js、SQL
- 自动化测试与故障诊断

## 加分项

- 有工作流引擎或招聘科技产品经验
`;

const SAMPLE_RESUME = `# 虚构候选人 A（仅用于自动化验收）

## 概要

后端工程师，四年 TypeScript 与 Node.js 项目经验。

## 经历

### 虚构软件团队｜后端工程师｜2022-06 至今

- 负责内部审批工作流服务，使用 TypeScript、Node.js 与 SQLite。
- 为事务写入、失败恢复和 API 增加自动化测试。
- 排查异步任务积压，补充运行监控与故障诊断手册。

## 技能

- TypeScript、Node.js、SQL、Playwright
- 中文书面协作

> 本文为虚构、无个人联系方式的测试样例，不对应任何真实人员。
`;

function writeSample(relativePath: string, content: string): void {
  const absolutePath = resolveWithinData(relativePath);
  fs.mkdirSync(resolveWithinData("samples"), { recursive: true });
  if (!fs.existsSync(absolutePath) || fs.readFileSync(absolutePath, "utf8") !== content) {
    fs.writeFileSync(absolutePath, content, "utf8");
  }
}

/** 两份默认输入都是虚构、无联系方式的固定样例；真实 RAAS 数据永不进入种子。 */
export function writeResumeSamples(): void {
  writeSample("samples/岗位JD示例.md", SAMPLE_JOB);
  writeSample("samples/简历示例.md", SAMPLE_RESUME);
}
