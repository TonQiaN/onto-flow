/**
 * 三方一致：插件目录（catalog.ts）、可执行组合（composition.ts）、散文文档
 * （docs/harness/）互相钉死（ADR-0013）。任何一边改了没同步，这里就红。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_CATALOG,
  PLUGIN_GROUPS,
  UPSTREAM_VERSION,
  catalogRowForEntryId,
  defaultMountedEntryIds,
  toggleMountedEntryIds,
  type PluginGroupId,
} from "./catalog";
import { runCompositionEntries } from "./composition";
import type { RunWorkspace } from "./workspace";

const REPO_ROOT = process.cwd();
const DOCS_DIR = path.join(REPO_ROOT, "docs", "harness");
const REFERENCE_DIR = path.join(REPO_ROOT, "_reference", "deepseek-harness");

function previewWorkspace(): RunWorkspace {
  const runDir = "/preview/run";
  return {
    runId: "preview",
    workflowId: "preview",
    runDir,
    workspaceDir: `${runDir}/workspace`,
    logsDir: `${runDir}/logs`,
    homeDir: `${runDir}/home`,
    pluginsDir: `${runDir}/plugins`,
    tmpDir: `${runDir}/tmp`,
    compositionPath: `${runDir}/cordis.yml`,
    imports: { instructionsDigest: "", items: [] },
  };
}

describe("插件目录 ↔ 组合", () => {
  it("默认组合的每个 entry 都被目录声明为默认挂载", () => {
    const ids = runCompositionEntries(previewWorkspace()).map((e) => e.id);
    for (const id of ids) {
      const row = catalogRowForEntryId(id);
      expect(row, `组合 entry「${id}」在目录里没有对应行`).toBeDefined();
      expect(
        row?.decision,
        `组合 entry「${id}」的目录决定是「${row?.decision}」，不是挂载类`,
      ).toMatch(/^(必挂|挂|自有)$/);
      expect(row?.mountedByDefault, `「${id}」目录标为按开关挂载，却出现在默认组合`).not.toBe(
        false,
      );
    }
  });

  it("目录声明为默认挂载的每一行都在默认组合里", () => {
    const ids = new Set(runCompositionEntries(previewWorkspace()).map((e) => e.id));
    for (const id of defaultMountedEntryIds()) {
      expect(ids.has(id), `目录说「${id}」默认挂载，组合里没有`).toBe(true);
    }
  });

  it("按开关挂载的行只在开关打开时进入组合", () => {
    const off = new Set(runCompositionEntries(previewWorkspace()).map((e) => e.id));
    const on = new Set(
      runCompositionEntries(previewWorkspace(), { toggles: { webSearch: true } }).map((e) => e.id),
    );
    for (const id of toggleMountedEntryIds()) {
      expect(off.has(id), `「${id}」是开关行，默认组合不该有`).toBe(false);
      expect(on.has(id), `「${id}」是开关行，开关全开后组合里应当有`).toBe(true);
    }
  });

  it("目录里每一行的分组都存在，工作流可切换的行不在骨架/沙箱/记录组", () => {
    for (const row of PLUGIN_CATALOG) {
      expect(PLUGIN_GROUPS[row.group], `「${row.package}」的组号非法`).toBeDefined();
      if (row.workflowToggle) {
        expect([2, 3].includes(row.group), `「${row.package}」标为可按工作流切换，但它在组 ${row.group}`).toBe(true);
      }
    }
  });

  it("目录里没有重复的包名或 entry id", () => {
    const packages = PLUGIN_CATALOG.map((r) => r.package);
    expect(new Set(packages).size).toBe(packages.length);
    const ids = PLUGIN_CATALOG.flatMap((r) => (r.entry && "id" in r.entry ? [r.entry.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("插件目录 ↔ 文档", () => {
  const groupIds = Object.keys(PLUGIN_GROUPS).map(Number) as PluginGroupId[];

  it("每组都有对应的文档文件", () => {
    for (const id of groupIds) {
      const file = path.join(DOCS_DIR, PLUGIN_GROUPS[id].file);
      expect(fs.existsSync(file), `缺少 ${file}`).toBe(true);
    }
  });

  it("目录每一行的包名出现在它那组的文档里", () => {
    const docs = new Map<PluginGroupId, string>();
    for (const id of groupIds) {
      const file = path.join(DOCS_DIR, PLUGIN_GROUPS[id].file);
      docs.set(id, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
    }
    for (const row of PLUGIN_CATALOG) {
      expect(
        docs.get(row.group)?.includes(row.package),
        `「${row.package}」没有出现在 docs/harness/${PLUGIN_GROUPS[row.group].file}`,
      ).toBe(true);
    }
  });

  it("README 记的上游版本与目录、package.json 钉版一致", () => {
    const readme = fs.readFileSync(path.join(DOCS_DIR, "README.md"), "utf8");
    expect(readme.includes(UPSTREAM_VERSION), `docs/harness/README.md 没有出现 ${UPSTREAM_VERSION}`).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (!name.startsWith("@deepseek-ai/dsh-")) continue;
      expect(version, `${name} 的钉版不是 ${UPSTREAM_VERSION}`).toBe(UPSTREAM_VERSION);
    }
  });

  it("每个定制行的上游版本等于目录钉的版本", () => {
    for (const row of PLUGIN_CATALOG) {
      const upstream = row.customization?.upstream;
      if (upstream === undefined) continue;
      expect(upstream.version, `「${row.package}」的定制记的上游版本过期`).toBe(UPSTREAM_VERSION);
    }
  });
});

describe("插件目录 ↔ 上游源码（_reference 存在时）", () => {
  const present = fs.existsSync(REFERENCE_DIR);
  it.skipIf(!present)("fork 行记的上游文件真的存在", () => {
    for (const row of PLUGIN_CATALOG) {
      const upstream = row.customization?.upstream;
      if (upstream === undefined) continue;
      const file = path.join(REFERENCE_DIR, upstream.path);
      expect(fs.existsSync(file), `「${row.package}」记的上游文件不存在：${upstream.path}`).toBe(true);
    }
  });
  if (!present) {
    // eslint 不在仓库里；这里只在 CI 上留一行说明，让跳过有据可查。
    console.info("[catalog.test] _reference/deepseek-harness 不在本机，跳过上游文件核对");
  }
});
