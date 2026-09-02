# 显式组合清单，以 headless 会话为体验基线

每次运行的 `cordis.yml` 由 `src/server/harness/composition.ts` 逐行生成，是一份平铺的显式清单：
不叠上游的 `dsh-base` / `dsh-headless` bundle，不用 patch 覆盖。取舍的参照物是**上游
`dsh --profile headless` 在工作区里开的那个会话**——一个 Action 会话应当与人在那个目录里手动
起 dsh 聊出来的会话体验一致，工作流只是把会话固定成流程。举证责任因此分两个方向：影响模型在
会话里怎么干活的行（骨架、模型的手脚、模型的上下文、会话的记录）默认跟上游一致，去掉要给理由；
只服务于人、宿主、网页、遥测的行默认不挂。每一行的决定、分组与定制标记记在
`src/server/harness/catalog.ts`，散文理由记在 `docs/harness/`，`catalog.test.ts` 把目录、组合与
文档三方钉死。

理由：每次运行一个短命子进程、没有 profile home，上游 patch 的「整行替换 config」语义对程序化
生成很不友好；更重要的是，显式清单让 `docs/harness/` 有明确身份——它就是我们与上游 base 的
差异审查记录，而 ADR-0006 已经把上游升级定性为代码变更。代价：上游往 base 里新加的行（例如
新的守卫）不会自动到达本项目，每次升级都要按 `docs/harness/AGENTS.md` 的步骤逐组重审。
