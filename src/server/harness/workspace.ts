/**
 * 运行工作区：每次运行拥有唯一真实目录，内含全部 Action 的会话 cwd、日志目录
 * 与本次运行的组合配置。目录只定义协作范围与文件所有权，不是安全边界。
 *
 * 初始化遵循最后发布：任一步失败即回滚整个运行目录，不留下看似可用的半成品。
 *
 * 技能与工具以 symlink 指向全局库的活目录导入，并在导入时算一次内容摘要
 * （ADR-0007）。摘要能证明「跟那次是不是同一份」，证明不了能把旧内容取回来。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/run/workspace.ts，
 * 差异是把快照复制换成 symlink。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../fs-safety";
import { assertSafeId, assertSafeName, newRunId } from "./ids";

/** 工作区内的项目级技能根，对齐上游 skill-filesystem 相对 cwd 的发现路径。 */
export const WORKSPACE_SKILLS_SUBDIR = path.join(".agents", "skills");
/** 工作区内的指令文件名，对齐上游 agent-instructions 的发现清单。 */
const WORKSPACE_INSTRUCTIONS_FILE = "AGENTS.md";
/** 运行 home 内的用户级指令文件名：上游固定读 $DSH_HOME/AGENTS.md。 */
const HOME_INSTRUCTIONS_FILE = "AGENTS.md";
/** 运行目录内的组合配置文件名。 */
const RUN_COMPOSITION_FILE = "cordis.yml";
/** 运行目录内 Action 子进程 cwd 的子目录名。 */
const RUN_WORKSPACE_SUBDIR = "workspace";
/** 运行目录内隔离的 harness home（DSH_HOME）子目录名。 */
const RUN_HOME_SUBDIR = "home";
/** 运行目录内 cordis 插件（Tool）的物化子目录名。 */
const RUN_PLUGINS_SUBDIR = "plugins";
/**
 * 运行目录内的会话持久化根目录名：组合把 session-persistence-jsonl 的 root 钉在
 * 这里，轨迹面板按同一个名字回读，两处必须同名。
 */
export const RUN_SESSIONS_SUBDIR = "sessions";
/**
 * 运行目录内 agent 临时文件的子目录名：经 TMPDIR 注入子进程，bash 的 mktemp、
 * Python 的 tempfile、Poppler 与上游沙箱围栏的 os.tmpdir() 三方因此对齐，运行
 * 删除时一并清掉，磁盘统计按运行目录计时自动包含。它是工作区的兄弟目录，
 * 不是子目录：上游 sandbox-local 断言临时根不得位于工作区内部。
 */
const RUN_TMP_SUBDIR = "tmp";
/** 运行输入落盘的工作区子目录名。 */
export const WORKSPACE_INPUTS_SUBDIR = "inputs";

/** 一项以 symlink 导入的能力（技能或工具）。 */
export interface ImportSpec {
  /** 导入后在工作区内的目录名。 */
  name: string;
  /** 全局库中该项的目录绝对路径；链接指向它，之后不再复制。 */
  sourceDir: string;
}

/** 导入记录：写进运行记录，用于事后判定内容是否漂移。 */
export interface ImportRecord {
  name: string;
  /** 导入时刻源目录的内容摘要。 */
  digest: string;
  fileCount: number;
  /** 链接指向的源目录，便于事后定位。 */
  sourceDir: string;
}

export interface CreateRunWorkspaceOptions {
  workflowId: string;
  runId?: string;
  /** 物化为 workspace/AGENTS.md 的工作流级共同指令。 */
  instructions: string;
  /**
   * 物化为 <run>/home/AGENTS.md 的全局默认指令：上游 agent-instructions 把
   * $DSH_HOME/AGENTS.md 当用户级指令读，因此每个 Action 会话都无条件读到（ADR-0016）。
   * 省略即不写，空串也写——空文件与没有文件对上游都是「无用户级指令」。
   */
  homeInstructions?: string;
  /** 链接到 workspace/.agents/skills/ 的技能：经 cwd 发现对全部 Action 可见。 */
  skills?: readonly ImportSpec[];
}

export interface RunWorkspace {
  runId: string;
  workflowId: string;
  runDir: string;
  workspaceDir: string;
  logsDir: string;
  /** 本运行子进程的隔离 DSH_HOME；凭据文件与用户级指令都不越出运行目录。 */
  homeDir: string;
  /** Tool 物化目录，进入组合配置的 include 面。 */
  pluginsDir: string;
  /** 本运行独占的临时目录（TMPDIR）；agent 运行期的一切临时文件都落在这里。 */
  tmpDir: string;
  compositionPath: string;
  /** 指令与各导入项的摘要，交由调用方写进运行记录。 */
  imports: { instructionsDigest: string; items: ImportRecord[] };
}

class RunWorkspaceError extends Error {}

/**
 * 对目录内容做确定性摘要：按相对路径排序，逐文件混入路径与字节。
 * 先把 root 解析成真实路径再遍历：data/skills/<slug> 是指向版本目录的链接，逐路径经链接读
 * 会在受理期间的技能重写中切到新版本，读到一份哪版都不是的摘要或撞上 ENOENT；技能已在摘要
 * 前被 retainSkillProjections 持有，旧版本目录不会被删，钉在真实路径上摘要就精确。
 */
async function digestDirectory(
  sourceDir: string,
): Promise<{ digest: string; fileCount: number; root: string }> {
  const root = await realpath(sourceDir);
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
      // 其余目录项（设备文件、socket）静默跳过：全局库里出现它们不是本模块该判的事。
    }
  }
  await walk(root);
  files.sort((a, b) => (path.relative(root, a) < path.relative(root, b) ? -1 : 1));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: files.length, root };
}

export function runDirPath(workflowId: string, runId: string): string {
  return path.join(DATA_DIR, "runs", workflowId, runId);
}

/**
 * 创建并发布一个运行工作区：目录树、物化指令、能力链接与导入摘要。
 */
export async function createRunWorkspace(
  options: CreateRunWorkspaceOptions,
): Promise<RunWorkspace> {
  assertSafeId("工作流 id", options.workflowId);
  const runId = options.runId ?? newRunId();
  assertSafeId("运行 id", runId);

  const seen = new Set<string>();
  for (const item of options.skills ?? []) {
    assertSafeName("技能名", item.name);
    if (seen.has(item.name)) {
      throw new RunWorkspaceError(`技能名「${item.name}」重复；导入名必须唯一`);
    }
    seen.add(item.name);
  }

  const runDir = runDirPath(options.workflowId, runId);
  const workspaceDir = path.join(runDir, RUN_WORKSPACE_SUBDIR);
  const logsDir = path.join(runDir, "logs");
  const homeDir = path.join(runDir, RUN_HOME_SUBDIR);
  const pluginsDir = path.join(runDir, RUN_PLUGINS_SUBDIR);
  const tmpDir = path.join(runDir, RUN_TMP_SUBDIR);

  let exists = false;
  try {
    await stat(runDir);
    exists = true;
  } catch {
    // 不存在正是期望路径。
  }
  if (exists) throw new RunWorkspaceError(`运行目录已存在：${runDir}；运行 id 必须唯一`);

  try {
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(pluginsDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    await mkdir(path.join(workspaceDir, WORKSPACE_INPUTS_SUBDIR), { recursive: true });
    // 空 .git 标记把上游指令链与技能发现的 projectRoot 钉在工作区内，
    // 防止 data/ 位于某个 Git 仓库中时向上发现越出运行边界。
    await mkdir(path.join(workspaceDir, ".git"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, WORKSPACE_INSTRUCTIONS_FILE),
      options.instructions,
      "utf8",
    );
    if (options.homeInstructions !== undefined) {
      await writeFile(path.join(homeDir, HOME_INSTRUCTIONS_FILE), options.homeInstructions, "utf8");
    }

    const items: ImportRecord[] = [];
    if ((options.skills ?? []).length > 0) {
      await mkdir(path.join(workspaceDir, WORKSPACE_SKILLS_SUBDIR), { recursive: true });
    }
    for (const item of options.skills ?? []) {
      const target = path.join(workspaceDir, WORKSPACE_SKILLS_SUBDIR, item.name);
      // 摘要先于建链：源目录读不到就该在这里失败，而不是留下一条断链。摘要钉在真实路径（版本目录）
      // 上，链接却指向逻辑路径 <slug>：两步之间技能被重写，链接会解析到新版本而摘要记的是旧版本，
      // runs.imports 就记下了一份没导入过的内容。所以建链后核对逻辑路径仍解析到被摘要的版本，
      // 变了就拆掉链接重来一遍（重写极少，循环几乎总是一次结束）。
      let digested = await digestDirectory(item.sourceDir);
      for (;;) {
        await symlink(item.sourceDir, target, "dir");
        if ((await realpath(item.sourceDir)) === digested.root) break;
        await rm(target);
        digested = await digestDirectory(item.sourceDir);
      }
      items.push({
        name: item.name,
        digest: digested.digest,
        fileCount: digested.fileCount,
        sourceDir: item.sourceDir,
      });
    }

    return {
      runId,
      workflowId: options.workflowId,
      runDir,
      workspaceDir,
      logsDir,
      homeDir,
      pluginsDir,
      tmpDir,
      compositionPath: path.join(runDir, RUN_COMPOSITION_FILE),
      imports: {
        instructionsDigest: createHash("sha256").update(options.instructions).digest("hex"),
        items,
      },
    };
  } catch (cause) {
    // 回滚半成品目录；回滚自身失败时保留首个错误并附注清理失败。
    try {
      await rm(runDir, { recursive: true, force: true });
    } catch (rollbackCause) {
      throw new RunWorkspaceError(
        `初始化运行目录失败：${String(cause)}；且回滚清理也失败：${String(rollbackCause)}`,
      );
    }
    throw cause;
  }
}
