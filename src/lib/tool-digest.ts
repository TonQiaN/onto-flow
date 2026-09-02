/**
 * Tool 契约摘要（ADR-0017）：专用调用入口钉住一个 Tool 时，钉的是它对模型与运行都
 * 可见的六个契约字段，而不是某个包装文件的字节——包装归平台，上游升版重生成包装
 * 不该让库里的 Tool 失去权威身份。纯函数，服务端与脚本共用。
 */
import { createHash } from "node:crypto";

/** 参与摘要的契约字段；与 tools 表的契约列一一对应。 */
export interface ToolContractDigestInput {
  publicName: string;
  description: string;
  parameters: unknown;
  output: unknown;
  timeoutMs: number | null;
  code: string;
}

/**
 * 规范 JSON：对象键递归排序，数组保序，值为 undefined 的键与 JSON.stringify 一样省略。
 * JSON Schema 只改键顺序不算契约变化，参数顺序（required 数组、enum 顺序）则是契约的一部分。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function toolContractSha256(contract: ToolContractDigestInput): string {
  return sha256Hex(
    canonicalJson({
      publicName: contract.publicName,
      description: contract.description,
      parameters: contract.parameters,
      output: contract.output ?? null,
      timeoutMs: contract.timeoutMs ?? null,
      code: contract.code,
    }),
  );
}
