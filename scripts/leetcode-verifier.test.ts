import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSandboxedPythonVerification } from "./leetcode-verifier";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("LeetCode 独立验收沙箱", () => {
  it("模型脚本不能写出本次运行工作区", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "data", "verifier-sandbox-test-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const artifact = path.join(workspace, "solution.py");
    const outside = path.join(root, "outside.txt");
    fs.mkdirSync(workspace);
    fs.writeFileSync(
      artifact,
      `open(${JSON.stringify(outside)}, "w").write("escaped")\n`,
      "utf8",
    );

    const result = await runSandboxedPythonVerification({
      workspaceRoot: workspace,
      artifactPath: artifact,
      verificationCode: "import runpy, sys; runpy.run_path(sys.argv[1])",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.sandbox).toMatchObject({
      mode: "workspace-write",
      enforcement: "full",
      denied: true,
    });
    expect(fs.existsSync(outside)).toBe(false);
  });
});
