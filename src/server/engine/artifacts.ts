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
export async function inspectArtifacts(
  ports: readonly ResolvedPort[],
  workspaceDir: string,
): Promise<ArtifactValidation> {
  const root = fs.realpathSync(workspaceDir);
  const inspect = async (port: ResolvedPort): Promise<ArtifactCheck> => {
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
    let opened: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      const canonical = fs.realpathSync(absolute);
      const relative = path.relative(root, canonical);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return reject("工作区内的产物文件", "产物指向工作区之外");
      const stat = fs.statSync(canonical);
      if (!stat.isFile()) return reject("普通文件", "产物不是文件");
      opened = await fs.promises.open(canonical, "r");
      const actual = await opened.stat();
      if (stat.dev !== actual.dev || stat.ino !== actual.ino)
        return reject("检查过的同一文件", "文件在打开前发生变化");
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
        // 大文件也保留完整散列；串行流读，最多保留解析上限内的内容，不一次装入内存。
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of opened.createReadStream({ autoClose: false })) {
          if (!Buffer.isBuffer(chunk)) throw new Error("产物读取结果不是字节");
          hash.update(chunk);
          size += chunk.length;
          if (size <= MAX_JSON_ARTIFACT_BYTES) chunks.push(chunk);
          else chunks.length = 0;
        }
        result.sha256 = hash.digest("hex");
        if (size > MAX_JSON_ARTIFACT_BYTES)
          return reject("不超过 32 MiB 的 JSON 文件", "文件超过解析上限");
        const bytes = Buffer.concat(chunks, size);
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
    } finally {
      await opened?.close();
    }
    return result;
  };
  const artifacts: ArtifactCheck[] = [];
  for (const port of ports) artifacts.push(await inspect(port));
  return {
    execution: "completed",
    checkedAt: new Date().toISOString(),
    businessAcceptance: "not_evaluated",
    artifacts,
  };
}
