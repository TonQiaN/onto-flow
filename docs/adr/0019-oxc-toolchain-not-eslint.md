# 用 oxc 工具链而非 ESLint

仓库的 lint 与 format 门禁是 oxlint（`--type-aware`，经 `oxlint-tsgolint`）与 oxfmt，进 CI 的
`check` 作业与 `npm run check`（typecheck → lint → fmt:check → test）；knip 先作为
`find-simplifications` skill 的线索工具，误报调零后提为第三道门。不加 git hook，CI 与
`npm run check` 是唯一的门。仓库自己的约定仍由 `src/rules.test.ts` 机械核对，不写自定义
lint 规则。

理由：仓库用 TypeScript 7（Go 编译器，npm 包里没有 JS API），typescript-eslint 在 TS 7.0 上
直接抛错，官方出路是用包别名并存一份 TypeScript 6 只给 ESLint 用——对多 agent 长期维护的
仓库，这种安装期的特殊安排是最容易被「修正」掉的坑，而 Next 文档只提 ESLint 与 Biome，读者
会默认 ESLint。`oxlint-tsgolint` 依赖 typescript-go、版本号直接跟 TS，把 typescript-eslint
的类型规则带了进来（`useAwaitThenable` 直接机械化「never `await db.…`」，`noFloatingPromises`
管住引擎与 SSE 里的异步），oxfmt 兼容 Prettier 且同源。Biome 一个二进制含 lint + format，但
类型规则靠自家推断、不经 TS checker，类型问题仍只剩 tsc 一道。代价：放弃 ESLint 的生态
（`eslint-config-next` 与海量插件）；oxfmt 比 Prettier 年轻、默认行宽 100；oxc 迭代快，版本
要像 `@deepseek-ai` 一样精确钉住，升级时 lint 结果可能变。
