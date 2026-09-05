import type { PortValue } from "./values";

/** 契约与样例共用的资源上限；二进制文件不受 JSON 解析上限限制。 */
export const MAX_ARTIFACT_SCHEMA_BYTES = 64 * 1024;
export const MAX_JSON_ARTIFACT_BYTES = 32 * 1024 * 1024;

export interface ContractIssue {
  path: string;
  expected: string;
  actual: string;
}

export interface ArtifactCheck {
  port: string;
  artifactPath: string;
  objectTypeName: string;
  validation: "file" | "json" | "schema";
  issues: ContractIssue[];
  /** 校验时存在的文件也保留在失败证据中，但不作为下游输入。 */
  file: PortValue | null;
  sha256: string | null;
}

/** 会话执行完成与契约验收分开；业务质量不由文件契约推断。 */
export interface ArtifactValidation {
  execution: "completed";
  checkedAt: string;
  businessAcceptance: "not_evaluated";
  artifacts: ArtifactCheck[];
}
