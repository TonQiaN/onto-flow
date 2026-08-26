import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dirStat } from "./disk";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("运行工作区磁盘计数", () => {
  it("两层布局按 runId 叶子计数，不把 workflowId 当成运行", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-disk-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "workflow-a", "run-1"), { recursive: true });
    fs.mkdirSync(path.join(root, "workflow-a", "run-2"), { recursive: true });
    fs.mkdirSync(path.join(root, "workflow-b", "run-3", "workspace"), { recursive: true });
    fs.writeFileSync(path.join(root, "workflow-b", "run-3", "workspace", "artifact.md"), "ok");

    expect(dirStat(root, 2)).toMatchObject({ topDirs: 3, files: 1, bytes: 2 });
  });
});
