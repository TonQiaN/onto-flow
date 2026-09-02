# DeepSeek Harness 组合审查记录

这个文件夹是本项目与上游 DeepSeek Harness（dsh）base 组合的**逐行差异审查记录**：上游每一个包在本项目里挂不挂、为什么、改了什么。声明面在 `src/server/harness/catalog.ts`（`PLUGIN_CATALOG`），可执行面在 `src/server/harness/composition.ts`，散文论证在这里；三方由 `src/server/harness/catalog.test.ts` 钉死（ADR-0013）。改这里之前先读 [AGENTS.md](AGENTS.md)。

## 立场

- **组合是显式平铺清单。** 每次运行的 `cordis.yml` 由 `composition.ts` 逐行生成，不叠上游 `dsh-base` / `dsh-headless` bundle，不用 patch 覆盖（ADR-0013）。上游往 base 里新加的行不会自动到达本项目，每次升级按 [AGENTS.md](AGENTS.md) 的步骤逐组重审。
- **体验基线是上游的 headless 会话。** 参照物是 `dsh --profile headless` 在工作区里开的那个会话：一个 Action 会话应当与人在那个目录里手动起 dsh 聊出来的会话体验一致，工作流只是把会话固定成流程。
- **举证方向按组分两边。** 影响模型在会话里怎么干活的行（组 1–4）默认跟上游一致，去掉要给理由；只服务于人、宿主、网页、遥测的行（组 5–8）默认不挂；组 9 是同一 seam 的替代 provider，不挂但记为备选；组 10 是本项目自己写的部分。
- **Action 只收窄、从不扩张。** 插件开关归全局设置与工作流设置，Action 层永远不开关插件（ADR-0015、ADR-0016）。

## 十组分类

组号即 `docs/harness/` 下的文件前缀；组名、文件名与默认方向取自 `catalog.ts` 的 `PLUGIN_GROUPS`。

| 组 | 组名 | 判据 | 默认方向 | 文档 |
|---|---|---|---|---|
| 1 | 骨架 | 没有它子进程起不来或没有模型调用：插件框架、装载器、模型路由、凭据、会话日志、agent 循环与它们依赖的库 | 必挂 | [01-骨架.md](01-骨架.md) |
| 2 | 模型的手脚 | 模型用来读写文件、跑命令、搜索、加载技能、连 MCP 的工具，及其 seam 定义、provider 与围栏 | 跟上游，去掉要理由 | [02-模型的手脚.md](02-模型的手脚.md) |
| 3 | 模型的上下文 | 决定模型每一步看见什么：指令载入、大输出落盘、压缩与剪枝、提醒、超时、自我组织 | 跟上游，去掉要理由 | [03-模型的上下文.md](03-模型的上下文.md) |
| 4 | 会话的记录 | 会话日志以什么格式落盘、何时刷盘、由谁投影与检索 | 跟上游 | [04-会话的记录.md](04-会话的记录.md) |
| 5 | 委派与自编排 | 让模型自己起 agent、写编排脚本、开后台作业、设定时的一切（ADR-0014） | 不挂：编排归图 | [05-委派与自编排.md](05-委派与自编排.md) |
| 6 | 面向人的交互 | 需要有人在场回答、评审、敲命令、看标题才有意义的行 | 不挂：运行中没有人 | [06-面向人的交互.md](06-面向人的交互.md) |
| 7 | 宿主与界面 | 服务浏览器客户端、常驻宿主、CLI 交接、热加载、以及 bundle 本身 | 不挂：不影响 agent | [07-宿主与界面.md](07-宿主与界面.md) |
| 8 | 遥测与身份 | 把会话内容、身份或反馈送出本机的行 | 不挂：内容不出本机 | [08-遥测与身份.md](08-遥测与身份.md) |
| 9 | 同一 seam 的替代 provider | 与已挂行注册同一个服务、二选一，或需要另一把凭据、另一个平台的实现 | 不挂，记为备选 | [09-替代provider.md](09-替代provider.md) |
| 10 | 本项目自有 | 本仓库自己写的插件、fork、包装与生成器 | 自有 | [10-本项目自有.md](10-本项目自有.md) |

### 「决定」的取值

`PluginDecision` 四值加两个特殊值：

- **必挂**：没有它运行起不来。包括不是组合行的库（`@deepseek-ai/cordis`、`dsh-scope`、`schemastery`）——它们没有 `entry`，由 runner 或上游插件在代码里装载。永远不可切换。
- **挂**：进入组合。`mountedByDefault` 省略时默认组合里就有；写 `mountedByDefault: false` 时目录**仍视它为「挂」**，但只在对应开关（`CompositionToggles`，今天只有 `webSearch`）打开时才进入组合——测试核对默认组合里没有它、开关全开后有它。
- **不挂**：不进组合。一句话理由在目录，完整论证在组文档。
- **待定**：审过但结论未定。今天没有任何行用它；一旦出现就是待办，不该长期停留。
- **备选**：同一 seam 里不挂但值得记的替代实现，组 9 专用；换实现时从这里找。
- **自有**：本项目自己写的部分，不存在「挂不挂」的问题，组 10 专用。

另有两个正交标记：`entry` 记组合里的 entry id（固定行写 `id`，按运行生成的 MCP 与 Tool 插件写 `idPrefix`）；`workflowToggle` 记能否由单个工作流覆盖全局默认（ADR-0016），只允许出现在组 2、3，骨架、沙箱、审批、记录一律 `false`，测试钉死。

## 定制方式三阶

按序优先：能用配置就不包装，能包装就不 fork。

1. **配置**：上游原样，只改 config 值。例：`dsh-sandbox-policy` 钉 `workspace-write` 与工作区根。
2. **包装**：上游原样，我们的代码在它的 seam（事件、waterfall、注册表）上加监听。例：`composeNodeScope` 在会话 scope 上注册 `agent/pre-step` 步数守卫与 `agent/request` 思考强度覆盖。
3. **fork**：抄上游源码改。例：`ontoflow-rpc` 源自上游 `packages/sdk/server/src/server.ts`。

被定制的行两处都要标：目录里写 `customization: { kind, what, why, upstream? }`；组文档里「定制」一节写**方式 / 改了什么 / 为什么 / 上游文件@版本**。包装与 fork 必须记 `upstream: { path, version }`——`version` 必须等于 `UPSTREAM_VERSION`，`path` 相对 `_reference/deepseek-harness`、在参照克隆存在时必须真实存在，两条都是测试。

## 基线版本

- **npm 钉版 `0.1.1-rc.2`。** `package.json` 里全部 `@deepseek-ai/dsh-*` 依赖与 `overrides` 都钉到这个字符串；`catalog.ts` 的 `UPSTREAM_VERSION` 是同一个值；这份 README 里出现该字符串是测试核对的一环。cordis 族（`@deepseek-ai/cordis`、`cordis-plugin-*`）与 `schemastery`、`cosmokit` 按闭包内各自的版本钉，不随 dsh 版本号走。npm 的 `latest` dist-tag 对这些包是过期的，裸 `npm install @deepseek-ai/...` 会拿到错误的一代。
- **上游 git。** tag `dsh-v0.1.1-rc.2`，指向合并点 `b150a55`（PR #2908，把 `release/dsh-0.1.1-rc.2` 分支并入 master）。
- **参照克隆。** `_reference/deepseek-harness`，gitignored、`tsconfig` 排除、只读，不是依赖：代码依赖的是 npm 闭包。事实来源在克隆里的 `packages/<组目录>/<包目录>/README.zh.md`、`packages/bundle/{base,headless,web-app}/cordis.patch.yml`、`docs/module-graph.zh.md`、`docs/architecture.zh.md`、`docs/capability-seams.zh.md`、`docs/tool-catalog.zh.md`。

## 三方一致

目录 ↔ 组合 ↔ 文档由 `catalog.test.ts` 钉死，任何一边改了没同步，`npm run check` 即红：

- 默认组合的每个 entry 都对应目录里一行决定为「必挂 / 挂 / 自有」且默认挂载的行；反之，目录说默认挂载的每一行都在默认组合里。
- `mountedByDefault: false` 的行不在默认组合里，开关全开后在。
- 每一行的组号合法；`workflowToggle` 只出现在组 2、3；包名与 entry id 无重复。
- 每组都有对应的文档文件，每一行的 `package` 字符串**原样**出现在它那组的文档里。
- README 出现 `UPSTREAM_VERSION`；`package.json` 的 `@deepseek-ai/dsh-*` 钉版全部等于它；每个定制行的 `upstream.version` 等于它。
- `_reference/deepseek-harness` 存在时，fork 与包装记的上游文件必须真实存在；不存在时这一条跳过并打印提示。

设置页的插件面板经 `/api/settings/composition` 读两样东西：按目录十组分区、逐行带决定/挂载状态/定制徽标的 `groups`（直接从 `PLUGIN_CATALOG` 投影），以及 `runCompositionEntries` 推导出的「下一次运行会挂什么」和最近一次运行真实落盘的 `cordis.yml`；目录钉住组合，所以面板、目录与文档不会各说各话。本项目没有长驻的 harness 宿主树，「现在挂了什么」在没有运行时不成立。

## 怎么加、删、改一行

1. **改目录**：在 `catalog.ts` 的 `PLUGIN_CATALOG` 里加、删或改那一行——组号、决定、`entry`、`workflowToggle`、一句话理由、定制标记。
2. **改组合**：决定为挂载类且默认挂载的行，在 `composition.ts` 的 `runCompositionEntries` 里加或删对应 entry；按开关挂载的行走 `CompositionToggles`。不挂、备选与库不动组合。
3. **改组文档**：在那一组的 `NN-*.md` 里加、删或改对应小节，标题里的 package 字符串与目录完全一致；定制行补「定制」一节。
4. **跑 `npm run check`**：三方钉死的测试全绿才算完；组合行的改动再跑 `npx tsx scripts/smoke-harness.ts`（花钱）确认子进程能 boot。

改一行的决定而不是加删（例如「挂」改「不挂」），同样走这四步。

## 文件索引

| 文件 | 内容 |
|---|---|
| [README.md](README.md) | 本文：立场、分组、取值、定制三阶、基线版本、三方一致、操作步骤 |
| [AGENTS.md](AGENTS.md) | 这个文件夹的维护规则与上游升级流程；`CLAUDE.md` 是它的 symlink |
| [01-骨架.md](01-骨架.md) | 组 1：cordis、装载器、app-boot、llm 与 deepseek 路由、凭据、会话、system-prompt、tools、agent 与 agent-loop、库 |
| [02-模型的手脚.md](02-模型的手脚.md) | 组 2：fs 与 tool-fs、附件、子进程、bash 与沙箱链、审批、glob/grep、str-replace-editor、技能、MCP、搜索三件套；不挂的 Code Mode、PTY、LSP、fetch |
| [03-模型的上下文.md](03-模型的上下文.md) | 组 3：AGENTS.md 载入、spill 三件套、token-meter 与压缩、剪枝、重复工具提醒、超时策略、todo；不挂的时间、tmux、@file、会话引用、persona |
| [04-会话的记录.md](04-会话的记录.md) | 组 4：JSONL 持久化与检查点、原子写；不挂的投影、统计、检索、导出 |
| [05-委派与自编排.md](05-委派与自编排.md) | 组 5：subagent、workflow、ralph、goal、jobs、schedule、Agent Teams，一律不挂（ADR-0014） |
| [06-面向人的交互.md](06-面向人的交互.md) | 组 6：提问、计划模式、权限档位、斜杠命令、会话标题、授权、badge 技能，一律不挂 |
| [07-宿主与界面.md](07-宿主与界面.md) | 组 7：客户端与宿主家族、bundle、typert、storage、settings、cmdline、hmr、stdout logger、include/group、cordis 自指工具、demo 与 test-support |
| [08-遥测与身份.md](08-遥测与身份.md) | 组 8：会话遥测与 OTel、匿名身份、消息反馈，一律不挂 |
| [09-替代provider.md](09-替代provider.md) | 组 9：pi-ai 网关、bash-local / fs-local、pwsh 与 Windows 围栏、SQLite 持久化与检索、storage 后端、E2B、Exa / Perplexity、Python 运行时、lsp-stdio、进程外 subagent、hooks 桥、ACP、上游 SDK 服务端与客户端 |
| [10-本项目自有.md](10-本项目自有.md) | 组 10：`ontoflow-rpc`（fork）、结构化输出运行时（fork）、`composeNodeScope`（包装）、Tool 包装生成器 `tool-plugin.ts`（包装）、按运行生成的 Tool 插件、`composition.ts`、`runner.ts`；另有「什么算改造、什么不算」 |
