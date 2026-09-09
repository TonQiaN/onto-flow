# 命令、验证与测试夹具

运行前先读根 [AGENTS.md](../../AGENTS.md)。下面的命令都从所用 checkout 的根目录执行；数据库与 `data/` 的位置取决于 `process.cwd()`，独立 worktree 不复用另一 checkout 的真实运行数据。

## Commands

命令实现以 [package.json](../../package.json) 为准，Node 主版本以 [.nvmrc](../../.nvmrc) 为准。修改命令时同步本指南与 [README](../../README.md) 中仍展示的示例；涉及产品行为的变化再同步所属 DESIGN 契约。

```sh
npm ci             # 按 lockfile 安装；有意更新依赖才用 npm install
npm run db:push     # drizzle-kit push，原地应用 schema，不提交 migration
npm run db:seed     # 平台基线：内置 text / file / json 对象类型和模型
npm run dev         # next dev -p 3592
npm run build       # next build，覆盖 typecheck 看不到的路由和配置错误
npm run typecheck   # 严格类型检查
npm run lint        # oxlint + oxlint-tsgolint
npm run fmt         # oxfmt；范围见 .oxfmtrc.json，Markdown 不在范围内
npm run fmt:check
npm run knip        # 未使用文件、导出、依赖；输出必须为空
npm run check       # typecheck && lint && fmt:check && knip && test
npm test            # vitest：src/ 与 scripts/ 下的 *.test.ts
npm run test:e2e    # Playwright：e2e/，单 worker
npx playwright test e2e/<name>.spec.ts
npx vitest run src/rules.test.ts
npx vitest run src/server/harness/catalog.test.ts
```

引擎不依赖独立外部服务，每运行启动 npm 安装的 `@deepseek-ai` 闭包。模型凭据 `DEEPSEEK_API_KEY` 放在 gitignored 的 `.env.local`；Next 启动时读取，直接运行脚本前须导出到进程环境。只传环境变量名，不打印值。PDF 输入要求 PATH 有 Poppler 的 `pdfinfo`、`pdftotext`、`pdftoppm`，转换由 Action 会话通过 bash 完成（ADR-0011）。

```sh
# 真实模型调用，收费；任何断言失败都必须非零退出
npx tsx scripts/smoke-harness.ts       # boot、一轮对话、产物、结构化输出、收束
npx tsx scripts/smoke-engine.ts        # 经 startRun 的两 Action 线性工作流
npx tsx scripts/smoke-graph.ts         # 扇出、汇总、具名出口、回边重入
npx tsx scripts/smoke-capabilities.ts  # 技能发现、工具调用、停用工具从清单消失
npx tsx scripts/smoke-parallel.ts [并发数]  # 默认 10，运行互不串号
npx tsx scripts/seed-resume.ts         # 不收费：案例定义与虚构样本
npx tsx scripts/seed-leetcode.ts       # 不收费：解题与测试循环、run_python Tool
npx tsx scripts/run-leetcode.ts [并发数]  # 默认 1，收费并独立验收定稿脚本
npx tsx scripts/run-resume.ts [data内岗位路径] [data内简历路径]
# run-resume 经内部 API，先保持本 checkout 的 npm run dev 运行
```

冒烟夹具与断言共用 [smoke-fixture.ts](../../scripts/smoke-fixture.ts)。临时修改全局设置的付费脚本经 `replaceSettingsIfCurrent` 安装和恢复；中途的用户保存优先，不能用旧快照覆盖它。

## Checks

- 仓库没有 git hook。完成前跑 `npm run check`；触及 `src/app/`、`next.config.ts`、`tsconfig.json` 加 `npm run build`。用户可见改动跑匹配的一个 e2e spec；全套 e2e 留给 CI。失败或未跑的检查在 PR 如实写明。
- [ci.yml](../../.github/workflows/ci.yml) 的 `check` 与 `e2e` 是合并门禁，PR 和 main push 都触发。`check` 是安装、类型、lint、格式、knip、单测、build；`e2e` 用全新平台基线数据库，启动 dev server，失败上传测试结果与报告。两个 job 都无模型凭据、不收费；job 名不要随意改，分支保护引用它们。
- [smoke.yml](../../.github/workflows/smoke.yml) 是手动/定时的付费验证，不是合并门禁；macOS 上依次准备数据库、跑 harness 与 engine 冒烟，缺凭据立即失败。选择 macOS 是因为已付费验过 Seatbelt 内核围栏；定时时间与超时读工作流文件，不在指令另抄一份。
- [claude.yml](../../.github/workflows/claude.yml) 只在提及 `@claude` 时评审，依赖 Claude GitHub App 与 `ANTHROPIC_API_KEY`。按 [REVIEW](../../.github/REVIEW.md)、根指令和任务专题读取；可执行命令以该工作流的 allowedTools 为准，不因此获得付费运行权限。
- [rules.test.ts](../../src/rules.test.ts) 是机械规则的权威检查：路由形状、客户端边界、共享规则单源、数据库同步调用、SQL 允许范围、全局状态、writer 注册、列表信封、精确钉版、技能双树、简化记录，以及指令体积和本地链接。测试里的例外必须仍是例外，修好即删；不再用长篇散文复制完整测试清单。
- lint 使用 Oxc，因为 TypeScript 7 的 npm 包不提供 typescript-eslint 所需的 JavaScript API（ADR-0019）。关闭规则只在 [.oxlintrc.json](../../.oxlintrc.json) 带理由配置；行内 `oxlint-disable-next-line` 带 `-- 理由`，不整文件关闭。
- [knip.json](../../knip.json) 使用 `ignoreExportsUsedInFile`：仅本文件使用的导出删 `export`。有明确主人但消费者不在仓库 TS 中的公开面用 `@public`，如 Tool 作者使用的 `ToolExecute`；不是保留无消费者代码的通用豁免。新增 knip 豁免必须说明理由。
- 新的 native/server-only 依赖加入 [next.config.ts](../../next.config.ts) 的 `serverExternalPackages`。保留 Turbopack `root`，防止 Next 认到仓库外的 lockfile。
- [composition-boot.test.ts](../../src/server/harness/composition-boot.test.ts) 真启子进程，覆盖默认组合、默认开关全关、搜索开关打开、样例契约 Tool 包装；不调用模型、不需凭据。Ubuntu 加载 npm 提供的 `landlock-run`，但这个 boot 测试不执行 bash，不能据此宣称内核围栏已验收。
- 改 Harness 接缝至少跑 `smoke-harness` 或在 PR 解释可跳过原因；升级上游按 [docs/harness/AGENTS.md](../harness/AGENTS.md) 同时跑 harness 与 engine 两个付费冒烟。

## Test fixtures

- **单元测试不得连接真实 `data/ontoflow.db`。** CI 的 check 没有 `data/`，vitest 文件并行。服务测试先通过 [createTestDb()](../../src/server/writers/test-db.ts) 从 schema 生成内存库，赋给 `globalThis.ontoflowDb`，再 `await import()` 被测模块；静态导入会触到真实库。不得手写测试 DDL 子集，否则会漏掉外键和唯一约束；所需目录自己用 `recursive: true` 创建。
- `src/**/*.test.ts` 与 `scripts/**/*.test.ts` 属于 vitest；`e2e/` 只放 Playwright，globs 不重叠。vitest 的 `@/*` alias 在 [vitest.config.ts](../../vitest.config.ts) 声明。
- 单测覆盖纯逻辑、非显然不变量与工程规则；用户可见行为由 Playwright 覆盖。
- `db:seed` 只写内置对象类型和模型，不写库实体、文件夹、修订、工作流、案例文件或运行历史。案例各有幂等 seed 脚本；`run-resume` / `run-leetcode` 可重建运行历史，但需要钱和时间，不能把真实库当一次性夹具。
- e2e 自建本 spec 的 `e2e-` 中文前缀实体，`beforeAll` 准备、`afterAll` 经 [cleanupByPrefix](../../e2e/helpers.ts) 收走（跳过 builtin，重查前缀）。全局 settings 是单份文档的例外：保存全量旧值，结束恢复。
- 运行页测试自己写 runs/rounds/usage，monitor 测试自己写已结束运行和真实工作目录，直接 SQLite 夹具仅属于这些 e2e；都需 teardown，不依赖本机历史。免费 input→output 图可以启动，经 `DELETE /api/runs/[id]` 清掉自己创建的运行。
- **e2e 不启动含 Action 的图，不点「执行清理 / 确认删除 / 中止该运行」。** 清理面板只跑 `dryRun`；测试免费图的依据是图中没有 Action，不是某个 spec 的特权。
- **不对真实使用会增长的计数、第一页包含、最新行或种子字面量作固定断言。** 断言自己的夹具，或现场取 API 载荷后核对 DOM；不能假设最新运行总是某个种子。
- Playwright 可能复用 3592 上已有服务，先确认服务从正确 checkout 根启动；否则测到的是另一套数据库。需要隔离时使用匹配 checkout 的服务，不让测试改动用户正在使用的实例。
