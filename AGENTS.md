# AGENTS.md

OntoFlow is a local workbench: Actions wired into workflow graphs, each run getting its own workspace directory and its own DeepSeek Harness subprocess, each Action a session inside it. Read [CONTEXT.md](CONTEXT.md) before naming anything.

## Stance: no compatibility layers

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Nothing outside this machine consumes OntoFlow, and there is no migration history to honor: `drizzle-kit push` applies `src/db/schema.ts` in place and no migration files are committed.
- Deleting a subsystem outright is the house precedent — [ADR-0005](docs/adr/0005-folders-not-tags.md) removed the tag tables, API, and components with no alias layer.

## Repository layout

```
src/app/          Next 16 App Router: every page and every REST route; no middleware, no auth
  api/              36 route handlers, each `export const dynamic = "force-dynamic"`
  workflows/[id]/   xyflow canvas editor; editor.tsx (1.2k lines) is the largest file here
  monitor/          six-tab console; sub-route == tab
  documents/        read-only browser over the purchase_plans rows a Tool wrote
src/instrumentation.ts   boot hook; the only server entry point that is not a route
src/components/library/  list/folder/reference/revision UI the five library pages reuse
src/db/           Drizzle schema + better-sqlite3 singleton (WAL, foreign_keys=ON)
src/lib/          pure, DB-free: graph.ts (validate/back-edge/exits), values.ts, http.ts
src/server/       server-only services; client code imports no value from here
  engine/           runner.ts (orchestration/cancel), action.ts (one node), reconcile.ts (startup)
  harness/          DeepSeek Harness absorption: composition generation, run
                    workspace, subprocess + stdio JSON-RPC, and rpc/ (the cordis
                    plugin the subprocess loads). The @deepseek-ai closure is
                    imported only here
  writers/          per-library write<Kind>() + registry + list.ts query contract + used-by guard
  monitor/          read-only aggregation, except cleanup.ts — the one destructive path
                    (deletes run_events and runs rows and data/runs/<id>; dryRun previews it)
  folders.ts references.ts revisions.ts resolve.ts fs-safety.ts
scripts/seed.ts   idempotent seed of the five libraries; e2e asserts on its literal strings
e2e/              8 Playwright specs + helpers.ts (prefix-scoped cleanup)
docs/             DESIGN.md (v1 + engine spec), DESIGN-V2.md (v2 contracts), adr/
data/             gitignored runtime root: ontoflow.db, runs/, uploads/, documents/, samples/
_reference/       gitignored third-party source, excluded from tsconfig; never import or edit
```

`.data/` is unrelated private residue with no code reference. Do not read or write it.

## Commands

Run everything from the repository root: `data/` resolves from `process.cwd()` in `src/db/index.ts`, `src/server/fs-safety.ts`, and `drizzle.config.ts`, so another working directory is another database. No external service has to be running — the engine is the `@deepseek-ai` npm closure booted inside a per-run subprocess ([ADR-0006](docs/adr/0006-deepseek-harness-as-execution-engine.md)). What must exist is the model credential: put `DEEPSEEK_API_KEY` in `.env.local` (gitignored) and export it before any command that runs a model. Credentials travel by reference name only: the value is picked from the Next process environment at spawn time and never enters a composition file, a log, or a run directory. Workflows that feed PDF inputs rely on Poppler's `pdfinfo`, `pdftotext`, and `pdftoppm` on `PATH` — Action sessions call them through the built-in `bash` tool ([ADR-0011](docs/adr/0011-bash-in-session-no-platform-preprocessing.md)).

```sh
npm install
npm run db:push     # drizzle-kit push; applies src/db/schema.ts in place, no migration files
npm run db:seed     # tsx scripts/seed.ts; idempotent; five libraries + folders + a v1 revision each + the two models
npm run dev         # next dev -p 3592
npm run build       # next build; catches route and config breakage typecheck misses
npm run typecheck   # tsc --noEmit under strict; the only static-analysis gate in the repo
npm run check       # typecheck && test; run this before declaring work done
npm test            # vitest run over src/**/*.test.ts and scripts/**/*.test.ts
npm run test:e2e    # playwright over e2e/; workers: 1
npx playwright test e2e/<name>.spec.ts   # one spec

# 花钱的冒烟与验收（真实调用模型，需要 DEEPSEEK_API_KEY）
npx tsx scripts/smoke-harness.ts       # 只验子进程：boot、一轮对话、产物、结构化输出、收束
npx tsx scripts/smoke-engine.ts        # 验整条引擎：两 Action 节点的线性工作流经 startRun 跑通
npx tsx scripts/smoke-graph.ts         # 验图能力：扇出、汇总、具名出口、回边重入
npx tsx scripts/smoke-capabilities.ts  # 验能力：技能被发现、工具被调用、停用工具从清单消失
npx tsx scripts/smoke-parallel.ts [并发数]  # 验并行：同一工作流同时 10 个运行全部成功、产物互不串号
npx tsx scripts/seed-resume.ts         # 装入「简历匹配评分」工作流（不花钱）
npx tsx scripts/seed-leetcode.ts       # 装入「LeetCode 解题验收」工作流：解题⇄测试回边循环 + run_python 工具（不花钱）
npx tsx scripts/run-leetcode.ts [并发数]  # 跑 LeetCode 工作流并对定稿脚本做本地独立验收；并发数默认 1
npx tsx scripts/run-procurement.ts     # 验收案例一：采购集采计划生成
npx tsx scripts/run-resume.ts [data内岗位路径] [data内简历路径]  # 经内部 API 验收案例二；先保持 npm run dev 运行
```

### Checks

Nothing runs on commit, push, or pull request: there is no CI, no git hook, no linter, and no formatter. These commands are the entire gate, and running them is your responsibility.

- Run `npm run check` before declaring work done; add `npm run build` when the change touches `src/app/`, `next.config.ts`, or `tsconfig.json`, because `build` catches route and config breakage `typecheck` misses.
- `next.config.ts` carries two pins a dependency change breaks: a new native or server-only package must join `serverExternalPackages`, and the Turbopack `root` pin is what stops Next latching onto a lockfile outside the repository.
- Unit tests are `*.test.ts` under `src/` or `scripts/`; everything under `e2e/` is Playwright, and the two globs do not overlap. `vitest.config.ts` re-declares the `@/*` alias, so a service test that bypasses it cannot resolve `@/db`.
- Unit tests cover pure logic and non-obvious invariants — today `src/lib/graph.ts` and `src/server/folders.ts`; everything user-visible is covered by Playwright.
- `test:e2e` starts a dev server or attaches to whatever already listens on 3592 (`reuseExistingServer`), so confirm that server was launched from the repository root or you are testing another database. A user-visible change runs its one matching spec, not the suite.

### Test fixtures cost money, but they are reproducible

`db:seed` writes the five libraries, their folders, a v1 revision each, the `models` rows, and the sample inputs under `data/samples/` — and nothing else: no runs, no run_events, no node_usage, no purchase_plans. The run history, archived documents, and cost figures the e2e specs read exist only in the gitignored local `data/ontoflow.db`.

- **The run history can be rebuilt.** `scripts/run-procurement.ts` and `scripts/run-resume.ts` regenerate it from scratch against the current engine, so losing `data/ontoflow.db` costs money and time rather than being unrecoverable. Rebuilding still means paid model calls — treat it as expensive, not as impossible. (This section used to say the fixture could not be regenerated; that was true of the opencode engine, whose runs no longer have any way of being reproduced.)
- E2E never starts a run that contains an Action node (that spends money) and never clicks 执行清理 / 确认删除 / 中止该运行; the cleanup panel is exercised only through `dryRun`. The one sanctioned run-starting shape is `parallel-runs.spec.ts`: an input→output workflow with no Action nodes costs nothing, still exercises the full engine lifecycle, and deletes its runs in teardown via `DELETE /api/runs/[id]`.
- E2E creates entities under a per-spec `e2e-` Chinese prefix and removes them in teardown through `cleanupByPrefix`, which skips `builtin` rows and re-checks the prefix. `settings.spec.ts` is the exception the rule cannot cover: settings are one document rather than named entities, so it saves the whole document in `beforeAll` and writes it back in `afterAll`.
- **Never assert a count, a first-page containment, or an exact row that real usage grows.** Fetch the API payload in the test and assert the DOM matches it. This bug class has now been fixed three times; the third time it was the run-detail spec asserting that the newest run was the procurement one.

## Conventions

- User-facing strings, error messages, code comments, and test names are Chinese; identifiers are English.
- Every API route body runs inside `handle()` from `@/lib/http`. Four do not: `api/monitor/stream` and `api/runs/[id]/events` return a raw SSE `Response`, and `api/models` and `api/documents` are one-statement GETs that predate the rule — do not copy them.
- **Name collisions are a database concern.** `handle()` maps `UNIQUE constraint failed` to 409, so writers never pre-check a name; folders are the exception, because SQLite cannot constrain a root level whose parent is NULL ([reason](src/db/schema.ts)).
- **Entity-body validation lives in the writer's `parse…Payload`** (workflow's is `parseGraphPayload`); a route hand-narrows only its own non-entity params. All of it is hand-written `typeof` narrowing — there is no schema library.
- **Write paths return a result object; the engine throws.** `runner.ts` turns a thrown error into `run_nodes.error` plus skipped downstream nodes. New service modules use `WriteResult` with `writeOk`/`writeFail` from `@/server/writers/types`; `folders.ts` and `revisions.ts` still carry private structurally identical `Result<T>` copies — converge on `WriteResult`, never add a fourth. `fs-safety.ts` and `monitor/cleanup.ts` throw deliberately and their callers map the throw.
- **better-sqlite3 is synchronous.** Drizzle calls end in `.get()` / `.all()` / `.run()`; never `await db.…`.
- Raw SQL goes through drizzle's `sql` tag and only where the query builder cannot express the aggregate: `monitor/`, `writers/list.ts`, `revisions.ts`, `api/runs/route.ts`. User input inside `LIKE` is escaped and paired with `escape '\'`.
- Process-level mutable state is parked on `globalThis` under an `ontoflow`-prefixed key so HMR cannot lose it: `ontoflowDb`, `ontoflowCancelledRuns`, and `ontoflowRunProcesses`. A module-level `const map = new Map()` is the bug this prevents.
- A server-module unit test assigns an in-memory database to `globalThis.ontoflowDb` and then `await import()`s the module under test; a static import reaches the real `data/ontoflow.db`.
- **There are no Server Actions.** Every mutation is a `fetch` to `/api/*`; new pages start with `"use client"` and load data in `useEffect`.
- Client code imports no runtime value from `@/server` or `@/db`. `import type` from `@/server/monitor/types` is the sanctioned exception, and that module's own `import type { NodeStatus, RunStatus } from "@/app/runs/lib"` is the one accepted reverse dependency.
- **Global settings are one JSON document in a single-row table**, validated whole at the write boundary in `src/server/settings.ts` and read once when a run starts — a change takes effect on the next run, and a running run holds the snapshot it started with. A paid script that temporarily changes this document installs and restores it through `replaceSettingsIfCurrent`; a user save made during the run wins instead of being overwritten by the script's stale snapshot. Credentials appear only as environment-variable names; the value is picked from the Next process environment at spawn time. An MCP `env` key whose name looks like a credential is refused, because that object is written verbatim into the run's composition file.
- **A globally disabled tool disappears from the session's tool list**, it does not fail when called. `tools.restrict` narrows the visible set and `tools.guard` covers tools registered after the session opened; the observable evidence is the tool's absence from `request/header`, not an error event.
- **The plugin panel reports a derivation, not a live tree.** There is no long-lived harness host inside the Next process — every run boots its own subprocess — so "what is mounted right now" has no answer between runs. `/api/settings/composition` reports the composition the next run would boot plus the last run's `cordis.yml` as it actually landed on disk.
- **All five library list GETs return `{ items, total, page, pageSize }`**, built from `parseListQuery` + `selectLibraryPage` + `listEnvelope` in `src/server/writers/list.ts`. Every other GET defines its own shape.
- The five library pages reuse `src/components/library/`; no page grows its own tree, toolbar, folder picker, or revision panel. Their filter state lives in the URL through `use-library-query`, never in component state.
- Workflows never enter folders; gate every folder path on `isFolderEntityKind`, not an ad-hoc comparison ([ADR-0005](docs/adr/0005-folders-not-tags.md)).
- **Delete protection is per-owner and there are exactly four.** The four referenceable libraries answer 409 through `usedByNames()`; workflow DELETE has its own running-run guard; folder DELETE has its own name-collision guard; run DELETE refuses a running run with 409 through `deleteRun` in `monitor/cleanup.ts` — the destructive path stays in that one module. Do not add a fifth, and do not hand-write a reference join — `src/server/references.ts` is the only module that joins references.
- **Every entity write records a revision inside the same transaction**, capturing the complete definition including relations, and rollback replays the same `write<Kind>()`; a route that can reach revision restore carries `import "@/server/writers";` or restore silently answers 501.
- Untrusted paths pass through `@/server/fs-safety` (`isWithinData` at the request boundary, `resolveWithinData` and `safeBasename` at use); the run subprocess reads and writes whatever is in its workspace.
- Ids are `crypto.randomUUID()` from the schema default; a caller supplies an id only when it must return that id before insert or preserve client-side edge references.
- **Nominal port typing is an edit-time rule, not a TypeScript one and not a runtime one.** Two ports connect only when their `objectTypeId` values are equal ([ADR-0002](docs/adr/0002-nominal-port-typing.md), amended by [ADR-0008](docs/adr/0008-artifacts-not-values.md)); ids stay bare `string`. Nothing checks at runtime that the artifact holds what its type claims — the only mechanical backstop is that a declared artifact must exist on disk.
- **The workflow graph is not a DAG.** Fan-out is one output port with several edges, synthesis is one input port with several edges, and an edge from an exit port back to an upstream Action is a legal cycle ([ADR-0009](docs/adr/0009-exit-ports-and-back-edges.md)). `classifyEdges` decides which edges are back edges by a stable DFS from the entry nodes, and that answer is load-bearing in three places: readiness ignores back edges (a node that waits on one deadlocks its own loop on the first pass), `downstreamOf` ignores them (or the closure swallows the whole cycle), and validation requires every back edge's target to declare a re-entry limit.
- **Every output port declares an artifact path, and a branching Action reports its exit.** Ports sharing an `exitName` form one exit; the data-plane result names the exit taken and only that exit's edges activate, the rest go dead and their downstream is skipped. Re-entry bumps the whole loop body's round together, and round N writes under `rounds/N/` so an earlier round is never overwritten.
- **A synthesis port waits for every incoming edge to settle, not for the first one.** Readiness on a port with several edges means all of them are satisfied-or-dead and at least one is satisfied. Treating "any edge satisfied" as ready lets a synthesis node start before its siblings finish and silently read a subset — observed as a six-critic report that only found five verdicts while all six were on disk.
- **A run with output nodes but none reached is a failure, not a success.** An unreached output node on an untaken branch is normal; all of them unreached means the run produced nothing.
- **A canvas node is a reference to the shared Action**, so editing it from the canvas edits that Action everywhere ([ADR-0004](docs/adr/0004-canvas-edits-the-shared-action.md)).
- Input and output node ports are always named `"value"`.
- **A Tool is a cordis plugin with Action scope.** `tools.code` exports `name` / `inject` / `apply`; the run materializes the graph-wide union under `<run>/plugins/` and includes every plugin by absolute path on the global tool surface, then each Action session applies `toolFilter` so only that Action's referenced Tools remain visible (along with unscoped built-ins). Module resolution walks up from the run directory to the repository root, so `node:` builtins and the repo's dependencies are importable — the old "cannot import anything from this repository" rule is gone with opencode.
- **The JSON Schema subset is narrower than JSON Schema.** A type array (`type: ["integer", "null"]`) is rejected, and a Tool whose schema uses one fails at plugin load, which takes the whole run down before any node starts. Omit the field instead of typing it nullable. The same subset governs an Action's data-plane schema.
- **`output.render` takes `(args, value)`, not `(value)`.** Getting it wrong renders `undefined` and the call dies with `output.render returned non-lossless JSON`, which reads like a serialization bug rather than an arity bug. The Tool template in `src/app/tools/tool-editor.tsx` carries the correct shape.
- **A Skill is projected to disk, not injected.** `src/server/skill-library.ts` writes every Skill to `data/skills/<slug>/SKILL.md`; a run symlinks the declared ones into `workspace/.agents/skills/` and upstream `skill-filesystem` discovers them from the session cwd. The model sees name and description and loads what it judges relevant. Anything that must always apply belongs in the Action's rule or the workflow-level instructions in `workspace/AGENTS.md`.
- **The skill directory name is an ASCII slug, never the library name.** Upstream enforces `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` on skill names, and this repository names entities in Chinese — a Chinese name is dropped with nothing but a `warn` in the subprocess log, so the skill silently never reaches the model. `skillSlug()` derives the directory name and the frontmatter `name`; the Chinese name is prefixed onto the description, which is what the model actually matches on.
- A `models` row's `providerId` is a **dsh provider route**, not a vendor name: `llm-deepseek` registers exactly `deepseek-official`. Adding a model means `upsertModel` in `scripts/seed.ts` plus, for a route no adapter serves yet, a new entry in `runCompositionEntries`. No route writes `models`.

### The harness seam

Every rule here was learned the hard way while replacing opencode with dsh. Read the header comments of `src/server/harness/runtime.ts`, `src/server/harness/rpc/server.ts` and `src/server/engine/action.ts` before touching sessions, events, usage, or cancellation.

- **One run, one subprocess, one workspace.** `executeRun` creates the run directory, spawns `node --import tsx src/server/harness/runner.ts <cordis.yml>`, and disposes it in a `finally`. There is no build step for server code: the subprocess loads the same TypeScript the Next process does.
- **Runs execute in parallel and are mutually independent.** Nothing serializes runs: cross-run state is keyed by runId on `globalThis` or lives inside the run's own directory, and anything new must follow suit. `startRun` is the only admission gate — at `MAX_CONCURRENT_RUNS` simultaneously running runs it answers 429 instead of queueing, because each run is a whole node+tsx+dsh subprocess; the external caller owns any queue.
- **The RPC plugin is named in the composition by absolute path, not by package name.** The cordis loader resolves bare specifiers from its own location inside `node_modules`, and this repository has no self-referencing symlink there, so a bare name fails at boot. `boot`'s `bareModuleBaseUrl` does not rescue it.
- **Pin every user-level root inside the run directory.** `skill-filesystem` defaults `agentsHome` to `~/.agents`, so a run will happily discover and load the machine owner's personal skills — observed in practice as an agent looping through unrelated skills and then failing to read their resources. The per-run composition pins both `dshHome` and `agentsHome` under the run's home directory; workspace isolation is not automatic.
- **Cap the steps of a node.** Upstream `agent-loop` has no step limit, so a looping agent burns tokens until the node's wall-clock timeout. Each session registers an `agent/pre-step` guard from `NODE_MAX_STEPS`; exceeding it ends the turn with no structured output, which fails the node.
- **stdout belongs to the protocol.** The per-run composition must never include a stdout logger; harness stderr goes to `<run>/logs/harness.stderr.log`.
- **Every Action session has `bash`, and every run input is materialized as a workspace file.** The composition mounts the upstream shell chain (`dsh-tool-bash` + `dsh-bash-sandbox` + `dsh-subprocess-local` + `dsh-shell-env`); `bash` is an unscoped built-in like `read`/`write`, and format conversion of inputs happens inside the Action session, never in the Next process ([ADR-0011](docs/adr/0011-bash-in-session-no-platform-preprocessing.md)). Files are copied verbatim; text/json inputs become `inputs/<nodeId>/<label>.md|.json`, and prompts reference paths only — `describeInput` throws on an inlined value rather than resurrect the silent-truncation path ([ADR-0012](docs/adr/0012-inputs-materialize-as-files.md)).
- **One sandbox policy covers bash and write/edit, at two different strengths.** `dsh-sandbox-policy` at `workspace-write` confines file writes of both families to the run workspace plus the system temp dirs, but only bash gets a kernel fence: its argv is wrapped by Seatbelt (`sandbox-exec`) and fails closed when the runner is unavailable, while write/edit go through `dsh-fs-sandbox`'s in-process path check — upstream calls it a policy fence, not a kernel boundary, and it never touches the runner. Reads and network are not confined for either family, and `dsh-user-approval` at `policy: "never"` auto-rejects escalation requests.
- **Pin `@deepseek-ai` versions exactly.** The npm dist-tag `latest` on these packages is stale; every dependency is pinned to the closure's version (`0.1.1-rc.2`), and a bare `npm install @deepseek-ai/...` will fetch the wrong generation.
- **思考强度 reaches the model only through the `agent/request` waterfall.** `AgentOptions` carries just provider/model/maxTokens, and the `GenerateOptions` handed to `llm/stream` is frozen — assigning to it throws mid-turn. The listener is registered on the session's own scope in `composeNodeScope`, so it is filtered to that agent and released with the session.
- **Overwrite the effort unconditionally.** agent-loop resolves the adapter default into the call config before the waterfall runs, so a "only set it when unset" guard never fires.
- **Structured output is a scope-registered tool, not a provider feature.** Each session registers its own `structured_output` with the real schema; two-phase commit on `tools/result` is what makes the captured value authoritative.
- Token usage arrives as one `usage` chunk per step and does not accumulate, so summing is correct — unlike opencode's repeated `message.updated`, there is no double-count hazard here. `outputTokens` already includes reasoning (the adapter takes `completion_tokens` verbatim), so never bill or total reasoning as an extra bucket.
- **Costs are CNY, computed at write time.** `src/server/pricing.ts` carries the official DeepSeek peak/off-peak price table; `node_usage.cost` prices each usage chunk by its own arrival time, `run_nodes.cost` accumulates per node, and an engine-generated `usage` run-event surfaces each Action's spend in the event log. Unknown models cost 0 — a zero on the cost page means "no price entry", never a guessed price. The `node_usage` unique key includes `run_id` because session ids are node ids and repeat across runs of the same workflow.
- **Session events must be written to SQLite as they arrive.** Both SSE endpoints poll the database and there is no in-process pubsub, so `onSessionEvent` writes `run_events` rows live; batching them until the node finishes makes the run page look frozen.
- **The run snapshot is written before the session is created**, from ports re-read at execution time; a run whose ports changed mid-flight aborts rather than produce output the snapshot cannot explain.
- **A declared artifact that is not on disk fails the node.** The model saying it wrote the file is not evidence; this is the only mechanical backstop the dual-channel result has ([ADR-0008](docs/adr/0008-artifacts-not-values.md)).
- **`cancelled` is a terminal state distinct from `failed`** and leaves `run.error` null; a prompt that throws after cancellation is cancelled, not failed.
- **A run never stays `running`.** Terminal state is written by `executeRun`, by `cancelRun`, by `failWholeRun`, and at process start by `reconcileOrphanRuns` through `src/instrumentation.ts`.
- **A subprocess disposal failure quarantines the run.** If `dispose()` cannot prove the child exited even after its termination escalation, keep the run in `activeRuns` and retain its process handle; file preview, cleanup, deletion, and new-run capacity must remain fail-closed until the Next process restarts and owns teardown. If both session close and process disposal are unconfirmed, keep that session's usage rollup live as well: late chunks must idempotently refresh `run_nodes` and its existing `usage` event until process exit is confirmed.
- Both SSE endpoints poll SQLite; there is no in-process pubsub, and the run stream ends only after three silent ticks past terminal state.

## Comments and documentation

A comment that records why a workaround exists is the rule itself — `longHaulFetch`, the per-workspace event pump, the `SUM` rollup, `LIKE` escaping, the quiet-tick stream ending — so deleting the comment deletes the rule. Comments state behavior, failure, timing, and ownership in Chinese; they do not narrate control flow or restate code. Every remaining `any` carries a comment naming why narrowing is infeasible. When a change alters a contract that [docs/DESIGN.md](docs/DESIGN.md) or [docs/DESIGN-V2.md](docs/DESIGN-V2.md) states, or settles a term, update that document in the same change.

## Decisions and the glossary

- [CONTEXT.md](CONTEXT.md) owns domain vocabulary and semantics only; keep implementation out of it and update it the moment a term is settled.
- [docs/DESIGN.md](docs/DESIGN.md) owns the v1 contract and the current DeepSeek Harness engine spec; [docs/DESIGN-V2.md](docs/DESIGN-V2.md) owns the list, folder, reference, revision, and shared-UI contracts.
- [README.md](README.md) is the product pitch and the only document carrying the demo walkthrough; it duplicates the startup and test commands from the Commands block above and restates behavior the engine spec owns, so change README, that block, and the spec together or change none of them.
- The eight `/api/monitor/*` routes have no written contract; `src/server/monitor/` is their source of truth.
- An irreversible, surprising, genuinely traded-off decision gets an ADR at `docs/adr/NNNN-slug.md`. The three-of-three test and the numbering rule live in [ADR-FORMAT.md](.claude/skills/domain-modeling/ADR-FORMAT.md); the house shape is a Chinese title, the decision, then a `理由：` paragraph ending in the cost, as in [ADR-0005](docs/adr/0005-folders-not-tags.md).
- A superseded ADR stays in place: link the replacement from the old one and the old one from the replacement, as [ADR-0003](docs/adr/0003-tags-not-folders.md) and ADR-0005 do.
- Cite an ADR from code by bare id, in the comment at the line the decision constrains (`（ADR-0005）`).
- Use the [domain-modeling](.claude/skills/domain-modeling/SKILL.md) skill when changing terminology or recording a decision. `.claude/skills/` and `.codex/skills/` hold byte-identical copies of all four skills; edit both trees in the same change.

## Editing these instructions

`CLAUDE.md` resolves to `AGENTS.md`; edit `AGENTS.md`. State only rules the repository already obeys, keep each rule self-contained with its rationale behind a link, and delete a rule the moment the code stops obeying it. The `nextjs-agent-rules` block below is rewritten by `next dev`; commit it with your work instead of deleting it from the diff.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
