import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunWorkspace } from "./workspace";

const controls = vi.hoisted(() => ({
  writeRunComposition: vi.fn(async () => {}),
  initialize: vi.fn(),
  dispose: vi.fn(),
  spawn: vi.fn(),
}));

const runProcess = {
  initialize: controls.initialize,
  dispose: controls.dispose,
};

vi.mock("./composition", () => ({
  writeRunComposition: controls.writeRunComposition,
}));
vi.mock("./runtime", () => ({
  RunProcess: { spawn: controls.spawn },
}));

import { launchRun, UnsettledRunLaunchError } from "./launch";

const workspace: RunWorkspace = {
  runId: "run-test",
  workflowId: "workflow-test",
  runDir: "/tmp/ontoflow-launch-test/run",
  workspaceDir: "/tmp/ontoflow-launch-test/run/workspace",
  logsDir: "/tmp/ontoflow-launch-test/run/logs",
  homeDir: "/tmp/ontoflow-launch-test/run/home",
  pluginsDir: "/tmp/ontoflow-launch-test/run/plugins",
  compositionPath: "/tmp/ontoflow-launch-test/run/cordis.yml",
  imports: { instructionsDigest: "test", items: [] },
};

beforeEach(() => {
  controls.writeRunComposition.mockClear();
  controls.initialize.mockReset();
  controls.dispose.mockReset();
  controls.spawn.mockReset();
  controls.spawn.mockReturnValue(runProcess);
});

describe("运行子进程启动", () => {
  it("initialize 与 dispose 都失败时把仍未静止的句柄交还调用方", async () => {
    const initializationError = new Error("initialize 请求超时");
    const disposalError = new Error("SIGKILL 后仍未退出");
    controls.initialize.mockRejectedValueOnce(initializationError);
    controls.dispose.mockRejectedValueOnce(disposalError);

    const failure = await launchRun(workspace).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnsettledRunLaunchError);
    expect(failure).toMatchObject({
      runProcess,
      initializationError,
      disposalError,
    });
    expect(controls.dispose).toHaveBeenCalledOnce();
  });

  it("initialize 失败但进程已静止时保留首个错误", async () => {
    const initializationError = new Error("组合加载失败");
    controls.initialize.mockRejectedValueOnce(initializationError);
    controls.dispose.mockResolvedValueOnce({ code: 0, signal: null, expected: true });

    await expect(launchRun(workspace)).rejects.toBe(initializationError);
    expect(controls.dispose).toHaveBeenCalledOnce();
  });
});
