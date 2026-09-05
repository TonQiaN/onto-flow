import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  MAX_JSON_ARTIFACT_BYTES,
  type ArtifactCheck,
  type ArtifactValidation,
} from "@/lib/artifact-contract";
import type { ResolvedPort } from "@/lib/graph";
import { DATA_DIR } from "@/server/fs-safety";
import { validateJsonArtifact } from "@/server/harness/artifact-schema";

/** 会话已收束后检查产物；失败文件留在工作区，错误不变成下游输入。 */
export function inspectArtifacts(
  ports: readonly ResolvedPort[],
  workspaceDir: string,
): ArtifactValidation {
  const root = fs.realpathSync(workspaceDir);
  const artifacts = ports.map((port): ArtifactCheck => {
    const artifactPath = port.artifactPath!;
    const result: ArtifactCheck = {
      port: port.name,
      artifactPath,
      objectTypeName: port.objectTypeName,
      validation: port.kind === "json" ? (port.jsonSchema ? "schema" : "json") : "file",
      issues: [],
      file: null,
      sha256: null,
    };
    const reject = (expected: string, actual: string) => {
      result.issues.push({ path: "$", expected, actual });
      return result;
    };
    const absolute = path.resolve(workspaceDir, artifactPath);
    if (!fs.existsSync(absolute)) return reject("声明的产物存在", "声明的产物没有写出来");
    try {
      const canonical = fs.realpathSync(absolute);
      const relative = path.relative(root, canonical);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return reject("工作区内的产物文件", "产物指向工作区之外");
      const stat = fs.statSync(canonical);
      if (!stat.isFile()) return reject("普通文件", "产物不是文件");
      result.file = {
        kind: "file",
        file: {
          path: path.relative(DATA_DIR, absolute),
          name: path.basename(artifactPath),
          mime:
            port.kind === "json"
              ? "application/json"
              : path.extname(artifactPath) === ".md"
                ? "text/markdown"
                : port.kind === "text"
                  ? "text/plain"
                  : "application/octet-stream",
        },
      };
      if (port.kind === "json") {
        if (stat.size > MAX_JSON_ARTIFACT_BYTES)
          return reject("不超过 32 MiB 的 JSON 文件", "文件超过解析上限");
        const bytes = fs.readFileSync(canonical);
        result.sha256 = createHash("sha256").update(bytes).digest("hex");
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return reject("UTF-8 编码的 JSON 文件", "文件包含无效 UTF-8 字节");
        }
        result.issues = validateJsonArtifact(content, port.jsonSchema ?? null);
      }
    } catch {
      return reject("可读取的产物文件", "产物读取失败");
    }
    return result;
  });
  return {
    execution: "completed",
    checkedAt: new Date().toISOString(),
    businessAcceptance: "not_evaluated",
    artifacts,
  };
}
