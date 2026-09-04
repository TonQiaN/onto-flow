# 简化：把 REVIEW.md 里已被 rules.test.ts 全覆盖的 6 条从人工评审位上撤掉，raw-SQL 那条收窄到机械核对不了的语义

状态: done

## 问题

`.github/REVIEW.md:5` 自己划了范围：

> 评审的产出只有一种：带文件与行号的具体问题。…… **能被 `src/rules.test.ts` 机械核对的条目 CI 已经跑过，
> 评审盯 CI 看不见的那些。**

但清单里有 6 条被 `src/rules.test.ts` **完全**覆盖、没有任何肉眼残留，另 1 条（raw SQL）只剩一句机械核对
不了的语义：

| REVIEW.md | 条目 | 覆盖它的断言 |
|---|---|---|
| `:26` | 没有 `await db.…` | `rules.test.ts:93`（且 `.oxlintrc.json` 的 `typescript/await-thenable` 再兜一道，ADR-0019） |
| `:30` | raw SQL 只经 `sql` 标签、白名单七个文件、`LIKE` 配 `escape '\'` | `rules.test.ts:340,348,354` 三条盖住「只经 `sql` 标签」「只在白名单文件」「`LIKE` 配转义」；**盖不住**「白名单文件里新加的一条原生 SQL 是不是查询构造器真表达不了的聚合」——这一句保留（Codex 对 #28 的复审指出） |
| `:46` | 每个 route 体跑在 `handle()` 里、两个例外没被复制 | `rules.test.ts:67,83` |
| `:47` | 每个 route `export const dynamic = "force-dynamic"` | `rules.test.ts:49` |
| `:48` | 客户端不从 `@/server` / `@/db` 导运行时值、没有 `"use server"` | `rules.test.ts:140,163` |
| `:49` | 能到达 restore 的 route 带 `import "@/server/writers";` | `rules.test.ts:267` |
| `:109` | `.claude/skills/` 与 `.codex/skills/` 字节一致 | `rules.test.ts:390` |

`npx vitest run src/rules.test.ts` 与 `catalog.test.ts` 今天 29 passed / 1 skipped（跳过的是
`_reference` 缺席时的上游文件核对，环境相关，不是过期豁免）。

**生产消费者：** 无（REVIEW.md 是给人与 review agent 读的）。
**测试 / 文档消费者：** `AGENTS.md:216`（「the same invariants regrouped by what to look at in a diff」）、
`.github/workflows/claude.yml:47`（要求 agent 先读 REVIEW.md 再读 AGENTS.md）。

**打败了哪条已记录的理由：** 打败的是 REVIEW.md 自己第 5 行的范围声明——这 7 条占着有限的人工注意力，
而 CI 已经在同一个 PR 上跑过它们。

## 提议

**⚠️ 需要用户拍板的措辞冲突：`AGENTS.md:115`（Checks 段）与 `:216`（Decisions 段）两处把 REVIEW.md 定义成
「this file's invariants **regrouped**」，
暗示完整覆盖；`.github/REVIEW.md:5` 定义成「只盯 CI 看不见的」。两句话不能同时为真。**

**路 1（撤掉，推荐）**：按 REVIEW.md:5 优先。删 `.github/REVIEW.md` 第 26、46、47、48、49、109 共
6 行；第 30 行收窄成「白名单文件里新加的原生 SQL 必须是查询构造器表达不了的聚合，且 `src/rules.test.ts`
的允许名单没有变长」；在 §0「门槛先看」加一行「CI 的 `check` 作业跑 `src/rules.test.ts`，它机械核对的约定
（`force-dynamic`、`handle()` 例外、`await db.`、客户端边界、`globalThis` 前缀、raw-SQL 白名单、
`LIKE` 转义、`@deepseek-ai` 钉版、skills 双树、记录树骨架）评审不必重复勾，**但白名单变长了要问为什么**」
——最后半句是唯一真正需要人看的部分。连带把 `AGENTS.md:115` 与 `:216` **两处**都改成「the invariants **CI cannot check**,
regrouped by what to look at in a diff」——同一契约声明了两次，只改一处就把本记录要消的矛盾原样留下。

**路 2（保留，改软措辞）**：按 `AGENTS.md:115` / `:216` 优先。给这 7 条各加一句「（`rules.test.ts` 已机械核对，
评审只需确认没有新增例外）」，并把 `.github/REVIEW.md:5` 那句改软。净行数为正。

推荐路 1：人工评审的稀缺资源是注意力，一份 117 行的清单里有 6 行永远勾对，训练的是「一路勾下去」。
REVIEW.md 与 AGENTS.md 的两处声明必须同一个 commit 改。

**不删**的三条（看着像被覆盖，其实不是）：`:50`（信封：测试只钉 import，运行时形状仍需肉眼）、`:58`
（`globalThis` 前缀已覆盖，但「模块级 `const map = new Map()`」不可机械核对）、`:15`（`@deepseek-ai`
钉版：测试只核对**直接**依赖进 `overrides`，传递依赖漏了不会红，见 `catalog.test.ts:174-183`）。

## 放弃了什么

「一份清单读完就覆盖全部不变量」的完整性；不跑 CI 的人工评审（例如只读 diff 的外部评审者）会漏掉这 6 条。
反方最强的说法是「REVIEW.md 也是新人理解不变量的入口」——但那个用途归 `AGENTS.md`，REVIEW.md:5 明说自己
不是。

## 验收

`.github/REVIEW.md` 里不再出现被 `rules.test.ts` 全覆盖的条目（PR 描述里附一份逐条对照表：REVIEW 行号 ↔
`rules.test.ts` 断言行号）；`npx vitest run src/rules.test.ts` 绿；`npm run check`。纯文档，不碰四处高
代价接缝。

## 风险

中。这是评审流程本身的改动，且与 `AGENTS.md:115` / `:216` 的措辞冲突，必须三处同一提交改；`claude.yml` 的
`@claude` 评审读的就是这份清单，撤掉的 6 条从此完全依赖 CI——若哪天有人把 `rules.test.ts` 的某条断言连同
被它保护的规则一起删掉，就没有第二道人工闸门了。

预估净删约 5 行（删 6 行、收窄 1 行、加 1 行）；风险等级：中。

## 落地

[PR #50](https://github.com/TonQiaN/onto-flow/pull/50)。

**与提议的差异：** 用户拍板选路 1（撤掉）。撤的 6 条、收窄的 1 条、§0 新增的 1 条都按提议做了；
另有两处提议没点名、但不改就会自相矛盾的连带：

- `.github/REVIEW.md` 第 4 节的标题「路由与客户端边界」在四条被撤掉之后，剩下的全是列表载荷与
  页面复用，改成「路由载荷与页面」。
- `AGENTS.md` Checks 段那句「A rule here changes in the same commit as that test **and the matching
  REVIEW.md line**」与「Editing these instructions」里的「change **the three** together」，在
  「机械核对的规则不再有 REVIEW.md 行」之后都为假，一并改准。

记录里说**不删**的三条（信封、模块级 `const map = new Map()`、`@deepseek-ai` 传递依赖钉版）
逐条复核后原样保留。

还有一处是撤这 6 条的**前提补齐**：Codex 对 #50 的复审指出，`handle()` 那条其实没被完全覆盖——
`METHOD_RE` 只认 `export function GET` 这种函数声明，一个 `export const POST = async … =>` 绕过
它不算方法，同一文件里另有一个走 `handle()` 的函数声明就把两边计数配平了，断言看不见。撤掉人工
那条之前必须先把测试补齐，否则「完全依赖 CI」这个前提不成立。第二轮点出 `const post = async () => …; export { post as POST };`
同样绕得过，第三轮点出更根本的一层：**计数是全文件的、不是按方法的**——一个方法里「先
`return new Response(…)` 再 `return handle(…)`」两条分支就能把 `methods === handled` 配平。

三轮合起来的结论是「数个数」这个做法本身不对。断言改成按方法查，与它自己的测试名（「每个导出
方法体都**以** `return handle(` **起头**」）对齐：先把对外方法名解析出来（函数声明、
`export const GET = …`、`export { post as POST }` 三种写法，再导出的回去找本地声明），再按圆 /
方括号配平扫到各自的函数体开头，要求体的**第一句**是 `return handle(`；箭头的表达式体补一个隐式
`return` 走同一条判断；声明写法超出扫描能力（例如写了带 `{` 的返回类型注解）时报「定位不到函数体」
而不是悄悄放行。

第四轮点出扫描没有停在本条语句上（`export const GET = raw;` 会一路吃到下一个方法的 `{`），
第五轮点出多声明符 `export const helper = 1, POST = async () => …` 又绕过一次。

五轮下来的结论是**做法本身要反过来**：文本扫描永远追不上 TypeScript 的全部合法写法，每补一种就
还有下一种。断言改成**只认「导出的函数声明」这一种写法，别的一律记违规**——仓库今天 56 个方法
导出全是 `export async function`（唯一的 `export const` 是 `dynamic = "force-dynamic"`），所以这
不是新规矩，是把已经在遵守的写法钉住。具体三条：
`export async function GET(…)` 的体第一句必须是 `return handle(`；
`export const / let / var` 的整条语句（按括号配平找分号，多声明符一起看）里出现方法名就是违规；
`export { … }` 导出方法名、以及 route 里出现 `export *`，都是违规。未知写法一律朝红的一边倒。

连带把 AGENTS.md 的 Conventions 那句补成「an HTTP method is an exported function declaration whose
first statement is `return handle(` — never a `const`, an alias, or a re-export」，理由写在同一句里
（这一种写法才让 `rules.test.ts` 能靠读文件判定）。

八种写法反向验证过（临时加进一个 route，跑完随即还原，`git diff` 干净）：

| 写法 | 期望 | 实际 |
|---|---|---|
| 体内先 `return new Response(…)` 再 `return handle(…)` | 红 | 红「POST 的方法体第一句不是 return handle(」 |
| `export const PUT = async () => new Response(…)` | 红 | 红「PUT 写成了 export const / let / var」 |
| `const post = …; export { post as DELETE };` | 红 | 红「DELETE 走了 export { … } 再导出」 |
| `const raw = …; export const POST = raw;` | 红 | 红「POST 写成了 export const / let / var」 |
| `export const helper = 1, POST = async () => …` | 红 | 红，同上 |
| `const wrapped = async () => handle(…); export const POST = wrapped;` | 红 | 红，同上（合规实现走 const 也不许） |
| `export * from "./elsewhere";` | 红 | 红「route 里有 export *，可能带出方法」 |
| `export async function POST() { return handle(…) }` | 绿 | 绿 |

第六轮点出字面量：`export const helper = "x;", POST = …` 用字符串里的分号把语句边界骗断。补法是
扫之前先把字符串、模板串与注释的内容抹成空白（`stripLiterals`），并加一条自检——抹完顶层
`export` 的条数必须不变，变了说明扫描把一整段当成了字符串，直接记违规而不是继续判断。
`import { handle } from "@/lib/http"` 那一条仍看原文（它本身就是字符串）。route 里唯一的正则
字面量不含引号，不受影响。

十种写法反向验证过（临时加进一个 route，跑完随即还原，`git diff` 干净）：

| 写法 | 期望 | 实际 |
|---|---|---|
| 体内先 `return new Response(…)` 再 `return handle(…)` | 红 | 红「POST 的方法体第一句不是 return handle(」 |
| `export const PUT = async () => new Response(…)` | 红 | 红「PUT 写成了 export const / let / var」 |
| `const post = …; export { post as DELETE };` | 红 | 红「DELETE 走了 export { … } 再导出」 |
| `const raw = …; export const POST = raw;` | 红 | 红 |
| `const wrapped = async () => handle(…); export const POST = wrapped;` | 红 | 红（合规实现走 const 也不许） |
| `export const helper = 1, POST = async () => …`（多声明符） | 红 | 红 |
| `export const helper = "x;", POST = …`（字符串里的分号） | 红 | 红 |
| 注释里、模板串里的分号，同上两种 | 红 | 红 |
| 未闭合引号 | 红 | 红「抹字面量后顶层 export 数量变了，扫描不可信」 |
| `export * from "./elsewhere";` | 红 | 红「route 里有 export *，可能带出方法」 |
| `export async function POST() { return handle(…) }`、`export const MAX_X = 1;` | 绿 | 绿 |

第七轮把同一族问题铺开：撤掉的那几条里，`force-dynamic`（`includes('export const dynamic = …')`）
与 restore 的 `import "@/server/writers";` 都是**在原文上** `includes`，把那一行注释掉照样绿；
另外 `export const { POST } = handlers;`（解构）也还绕得过。三条一起补：

- 把抹字面量那个函数提到模块级 `stripCode(content, literals?)`：默认只抹注释，`literals` 为真时
  连字符串 / 模板串的内容一起抹。`force-dynamic`、restore 的 `import "@/server/writers";`、
  `restoreRevision` 的识别、`handle` 的 import 判定全部改成看抹过注释的文本；`handle()` 的语句
  边界扫描继续用 `literals: true`。
- 导出变量语句里**凡出现方法名**就违规，不再限于 `POST =`——解构、计算属性一并拦住（已抹字面量，
  字符串里的 "POST" 不误伤；`export const dynamic` 与 `export const MAX_UPLOAD_REQUEST_BYTES` 都
  不含方法名，不受影响）。

十四种写法反向验证过（临时改一个 route，跑完随即还原，`git status` 干净）。除前面十种外新增：

| 写法 | 期望 | 实际 |
|---|---|---|
| `export const { POST } = handlers;`（解构） | 红 | 红「POST 出现在 export const / let / var 里」 |
| 把 `export const dynamic = "force-dynamic";` 注释掉 | 红 | 红 |
| 把 restore route 的 `import "@/server/writers";` 注释掉 | 红 | 红 |
| 把 route 的 `import { handle } …` 注释掉 | 红 | 红「没有从 @/lib/http 导入 handle」 |

第八轮把「藏在字符串里的仿冒」也补上：`const marker = 'export const dynamic = "force-dynamic";'`
在只抹注释的视图里字还在。`stripCode` 抹白时长度与换行都保留，所以抹过的视图与原文偏移一一
对应——`occursAsCode(raw, snippet)` / `matchesAsCode(raw, re)` 先在原文里定位，再要求抹过字面量的
视图在同一段偏移上是同样的「形状」；注释掉的只剩空白、藏进字符串的内容也被抹白，两种都对不上。
三处存在性判定（`force-dynamic`、restore 的 `import "@/server/writers";`、`handle` 的 import）
与 `restoreRevision` 的识别都改走它。

十九种写法反向验证过（临时改一个 route，跑完随即还原，`git status` 干净）。除前面十四种外新增：

| 写法 | 期望 | 实际 |
|---|---|---|
| `const marker = 'export const dynamic = "force-dynamic";'` 顶替真导出 | 红 | 红 |
| `const marker = 'import "@/server/writers";'` 顶替真导入 | 红 | 红 |
| `const marker = 'import { handle } from "@/lib/http";'` 顶替真导入 | 红 | 红 |
| 注释掉 `force-dynamic`（回归） | 红 | 红 |
| 原样 | 绿 | 绿 |

`await db.` 与客户端边界 / `"use server"` 三条仍看原文，理由是失败方向：注释与字符串只能**多出**
文本、不能藏起真实代码，被它们欺骗的方向是误报（红）而不是漏放（绿）。撤掉人工检查怕的是漏放。

第九轮两条：`const marker = /export const dynamic = "…";/` 用**正则字面量**藏代码（`stripCode`
不认正则，那段像代码的文本原样留在视图里），以及 `export { post as "POST" }` 用**带引号的导出名**
绕过子句扫描（引号内容被抹白了）。第二条说明「逐种枚举导出写法」这条路还没走到头，于是把它换成
**导出形状白名单**：route 顶层只许两种形状——方法用的函数声明、`export const <标识符> = …`
（`dynamic` 与 uploads 的字节上限就是这一种），别的一律记违规。`export { … }`（含带引号的名字）、
`export const { POST } = …`、`export *`、`export default` 被这一条一次性全部拦下，`EXPORT_CLAUSE_RE`
与 `STAR_EXPORT_RE` 两段随之删掉。正则字面量用「前一个有效字符决定除号还是正则」这条常规启发式
识别，判错只会多抹白一段，方向是误报不是漏放。

二十六种写法反向验证过。除前面十九种外新增：

| 写法 | 期望 | 实际 |
|---|---|---|
| `const marker = /export const dynamic = "force-dynamic";/;` 顶替真导出 | 红 | 红 |
| `export { post as "POST" };` | 红 | 红「第 13 行的 export 形状不认识」 |
| `export const { POST } = handlers;`（回归） | 红 | 红（两条都报） |
| `export * from "./x";`（回归） | 红 | 红 |
| `export default function foo() {}` | 红 | 红（这一轮新拦下的） |
| `export async function POST() { return handle(…) }`、`export const MAX_X = 1;` | 绿 | 绿 |

第十轮：抹注释留下空白之后，`/* 说明 */ export async function POST(){}` 这种同行前缀会把锚死在
列 0 的 `^export` 全部躲过去。所有 `^export` 改成 `^[ \t]*export`；自检的两边也都改成抹过注释的
视图（只差字面量），免得同行注释前缀让自检误报。

三十二种写法反向验证过。除前面二十六种外新增：

| 写法 | 期望 | 实际 |
|---|---|---|
| `/* route */ export async function POST() { return new Response(…) }` | 红 | 红「POST 的方法体第一句不是 return handle(」 |
| `/* x */ export { post as "POST" };` | 红 | 红「第 12 行的 export 形状不认识」 |
| 未闭合引号（自检回归） | 红 | 红「抹字面量后顶层 export 数量变了」 |
| `/* route */ export async function POST() { return handle(…) }` | 绿 | 绿 |
| `/* c */ export const dynamic = "force-dynamic";` | 绿 | 绿 |
| 原样 | 绿 | 绿 |

今天仓库里 route 全是「函数声明 + 体第一句 `return handle(`」，十轮改写对现有 route 的判定一次
都没变过。

**REVIEW 行 ↔ rules.test.ts 断言逐条对照**（行号取本 PR 分叉点 `95de9f9`）：

| REVIEW.md 原行 | 条目 | 覆盖它的断言 |
|---|---|---|
| `:26` | 没有 `await db.…` | `src/rules.test.ts:92` |
| `:30` | 原生 SQL（**收窄，未撤**） | `:352`（只经 `sql` 标签、只在白名单文件）、`:360`（白名单文件今天仍在用）、`:366`（`LIKE` 配 `escape '\'`）——盖不住「新加的这条是不是查询构造器真表达不了的聚合」，这一句留下 |
| `:46` | route 体在 `handle()` 里、唯一例外没被复制 | `:66`、`:82` |
| `:47` | 每个 route `export const dynamic = "force-dynamic"` | `:49` |
| `:48` | 客户端边界、没有 `"use server"` | `:154`、`:175` |
| `:49` | restore route 带 `import "@/server/writers";` | `:279` |
| `:109` | `.claude/skills/` ↔ `.codex/skills/` 字节一致 | `:402` |

**验收实际跑了什么：**

- `npx vitest run src/rules.test.ts` → 绿（含记录树骨架门禁，记录已移入 `done/` 并改了状态行）。
- `npm run check`（typecheck + lint + fmt:check + vitest）→ 通过。
- `.github/REVIEW.md` 从 117 行减到 112 行；上表七条里六条已不在清单上，第 30 行只剩人要判断的那一句。
- e2e：不适用（纯文档）。付费冒烟：没跑（不触及 harness 接缝）。
