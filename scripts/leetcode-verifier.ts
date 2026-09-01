/**
 * 在与 Action bash 相同的 Harness shell/sandbox seam 内执行独立 Python 验收。
 * 验收对象由模型生成，绝不能退回裸 child_process；runner 不可用时由上游 fail-closed。
 */
import fs from "node:fs";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SandboxBashExecutor } from "@deepseek-ai/dsh-bash-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";

export interface SandboxedPythonResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandbox: {
    mode: "workspace-write";
    enforcement: "full" | "partial";
    denied: boolean;
  };
}

function canonicalArtifact(workspaceRoot: string, artifactPath: string): {
  workspaceRoot: string;
  artifactPath: string;
} {
  const root = fs.realpathSync(workspaceRoot);
  const artifact = fs.realpathSync(artifactPath);
  const relative = path.relative(root, artifact);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("独立验收脚本必须位于本次运行的工作区内");
  }
  return { workspaceRoot: root, artifactPath: artifact };
}

export async function runSandboxedPythonVerification(input: {
  workspaceRoot: string;
  artifactPath: string;
  verificationCode: string;
}): Promise<SandboxedPythonResult> {
  const paths = canonicalArtifact(input.workspaceRoot, input.artifactPath);
  const root = new Context();
  await root.plugin(LocalSubprocessRuntime);
  await root.plugin(SandboxPolicyService, {
    mode: "workspace-write",
    workspaceRoot: paths.workspaceRoot,
  });
  await root.plugin(LocalSandboxProvider, {});
  await root.plugin(SandboxBashExecutor, {
    cwd: paths.workspaceRoot,
    timeoutMs: 30_000,
    maxTimeoutMs: 30_000,
  });

  try {
    const result = await root.shell.run(
      root.shell.resolve({
        command: 'python3 -c "$ONTOFLOW_VERIFY_SOURCE" "$ONTOFLOW_VERIFY_ARTIFACT"',
        workdir: paths.workspaceRoot,
        timeoutMs: 30_000,
        stdoutMaxBytes: 64 * 1024,
        env: {
          ONTOFLOW_VERIFY_SOURCE: input.verificationCode,
          ONTOFLOW_VERIFY_ARTIFACT: paths.artifactPath,
          PYTHONDONTWRITEBYTECODE: "1",
        },
        sandboxPolicy: {
          mode: "workspace-write",
          workspaceRoot: paths.workspaceRoot,
        },
      }),
    );
    if (
      !result.sandbox ||
      result.sandbox.mode !== "workspace-write" ||
      result.sandbox.enforcement === undefined ||
      result.sandbox.runnerFailed
    ) {
      throw new Error("独立验收的 Harness 沙箱未生效，拒绝把裸执行当成成功");
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      timedOut: result.timedOut,
      sandbox: {
        mode: "workspace-write",
        enforcement: result.sandbox.enforcement,
        denied: result.sandbox.denied,
      },
    };
  } finally {
    await root.fiber.dispose();
  }
}
