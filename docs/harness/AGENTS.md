# docs/harness 的维护规则

这个文件夹是本项目与上游 DeepSeek Harness base 组合的逐行审查记录，与 `src/server/harness/catalog.ts`（声明面）、`src/server/harness/composition.ts`（可执行面）由 `src/server/harness/catalog.test.ts` 三方钉死（ADR-0013）。先读 [README.md](README.md) 再改任何一行。这里只写维护规则；分组、取值与操作步骤在 README。

## 结论钉在一个版本上

- 这里每一句关于上游的结论都是对 `0.1.1-rc.2` 说的（`catalog.ts` 的 `UPSTREAM_VERSION`）。上游处于 developer preview、明确声明会有破坏性变更（ADR-0006），包名、config 键、seam 形状都可能在下一版消失。
- 信任任何一行之前，先核对 `package.json` 里 `@deepseek-ai/dsh-*` 的钉版与 README「基线版本」一节写的是不是同一个字符串。不一致说明升级做了一半，先把升级流程走完，再来改行。
- 事实只从上游源码与 README（`_reference/deepseek-harness/packages/<组目录>/<包目录>/README.zh.md`）或本项目代码里取；拿不准的写进该组文档末尾的「待核对」小节，不要编。

## 升级上游 = 一次代码评审

上游升级是代码变更，不是依赖刷新（ADR-0006）；显式清单的代价就是上游往 base 里新加的行不会自动到达本项目（ADR-0013）。步骤按序：

1. **bump 钉版。** `package.json` 里全部 `@deepseek-ai/dsh-*` 依赖与 `overrides` 改到新版本字符串；`allowScripts` 里带版本号的键（`@deepseek-ai/dsh-subprocess-local@<版本>`）跟着改。cordis 族与 `schemastery`、`cosmokit` 按新闭包里的版本各自钉，不要顺手改成 dsh 的版本号。`npm install` 后核对 lockfile 里没有任何 `@deepseek-ai/*` 被解析到别的一代——`latest` dist-tag 是过期的。
2. **切参照克隆。** `_reference/deepseek-harness` 是 gitignored 的本机克隆，`git fetch --tags` 后 checkout 到新版本的 tag（本版是 `dsh-v0.1.1-rc.2`，合并点 `b150a55`）。没有克隆就重新 clone `https://github.com/deepseek-ai/deepseek-harness.git` 到这个路径。
3. **对照 base 与 headless 的 diff 逐组重审。** 拿新旧两版的 `packages/bundle/base/cordis.patch.yml` 与 `packages/bundle/headless/cordis.patch.yml` 做 diff，配合 `docs/module-graph.zh.md` 看包目录的增删：上游新加的行按它的组的默认方向定决定，删掉的行从目录与文档里移除，config 键变了的行改 `composition.ts` 并更新组文档的「配置要点」。fork 与包装的行逐个对照记下的上游文件重看：`ontoflow-rpc`、`structured.ts`、`composeNodeScope` 依赖的 seam 形状任何一处变了都要跟着改。
4. **改三方。** `catalog.ts`（含每个 `customization.upstream.version`——`V` 常量一改全跟）、`composition.ts`、对应的组文档。
5. **改 README 的版本串。** 「基线版本」一节的 npm 钉版、tag、合并点三项都换。
6. **`npm run check`。** 三方钉死的测试与 typecheck 全绿。
7. **付费冒烟。** `npx tsx scripts/smoke-harness.ts` 验子进程能 boot、一轮对话、产物、结构化输出、收束；`npx tsx scripts/smoke-engine.ts` 验整条引擎跑通。两个都要 `DEEPSEEK_API_KEY`。

## 改任何一边必须同步另外两边

- 目录多一行或少一行、组合多挂或少挂一个 entry、组文档少一个包名，`catalog.test.ts` 都会红；本地 `npm run check` 与 CI 的 check 作业（`.github/workflows/ci.yml`）都会跑它；没有 git hook。
- 组文档不是目录的复述：目录的 `reason` 是给面板与测试用的一句话，文档的「理由」要写完整论证。改决定时两边一起改，别只改一边让它们说两套话。
- 组合行的顺序依赖、必须钉死的路径与开关是机制级的坑，记在 `composition.ts` 的行内注释里；文档可以引用，不要复制一份出来等它过期。

## package 字符串与家族行

- 测试对每一行做的是**子串原样匹配**：目录里 `package` 字段的字符串必须一字不差地出现在它那组的文档里。写成行内代码即可，但不能改大小写、加空格、拆行、换成中文名。
- 家族行用通配写法（`@deepseek-ai/dsh-client-*`、`@deepseek-ai/dsh-host-*`、`@deepseek-ai/dsh-typert-*`、`@deepseek-ai/dsh-pwsh-*`）或斜杠并列写法（`@deepseek-ai/dsh-subagent-acp / claude-code / codex / dsh-sdk`、`@deepseek-ai/dsh-hooks-* / hook-protocol`、`@deepseek-ai/dsh-*-demo / test-support`）：文档里一节带过，但标题里的字符串必须与目录**完全一致**，包括空格与斜杠。
- 自有行的 `package` 是仓库内路径或带锚点的路径（`src/server/harness/rpc/server.ts#composeNodeScope`、`<run>/plugins/tool-*.ts`），同样原样出现。
- 只有决定值得说的行才单独立条；但目录里有的每一行都必须出现在文档里，哪怕只在一句话里带过。

## 参照克隆缺席时

- `_reference/deepseek-harness` 不在本机时，「fork 行记的上游文件真的存在」这一条测试跳过并打印 `[catalog.test] _reference/deepseek-harness 不在本机，跳过上游文件核对`，其余测试照跑。这是有意的：克隆是读源码的辅助，不是构建依赖，缺了不该红。
- 因此不要把「测试全绿」当成「上游路径核对过了」：改 fork 或包装行的 `upstream.path` 时，本机必须有克隆，亲眼看到那个文件。

## 为什么不把上游做成 submodule

- 代码依赖的是 npm 闭包，不是源码树；克隆只用来读 README 与源码。把它做成 submodule 会让每次 clone 都拖进一整个 monorepo，而 `tsconfig` 的 `exclude`、Next 的 Turbopack `root` 钉与文件监视都得继续绕开它。
- `_reference/` 是本机的私人书架，里面还放着与本项目无关的其它仓库，根 AGENTS.md 规定它 gitignored、`tsconfig` 排除、永不 import 或编辑。submodule 会把这个约定变成仓库的一部分。
- 版本的权威在 `package.json` 与 `UPSTREAM_VERSION`，不在某个 git 指针；测试在克隆缺席时跳过而不是红，正是为了让它保持可选。

## 语言与引用约定

与根 [AGENTS.md](../../AGENTS.md) 相同：用户可见文字、注释、文档正文一律中文，标识符与包名英文；引用 ADR 用裸编号（如 ADR-0013），不写标题；不叙述控制流，写行为、失败、时机与归属；不发明新术语，词汇以 [CONTEXT.md](../../CONTEXT.md) 为准。改动若改变了 `docs/DESIGN.md` 所述的引擎契约，同一变更里更新它；一个不可逆、令人意外、确有取舍的决定写 ADR，不写在这里。

`CLAUDE.md` 是指向本文件的相对 symlink，与仓库根一致；编辑 `AGENTS.md`。
