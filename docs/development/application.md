# 页面、API 与写入约束

修改页面、组件、共享规则模块、数据库、写入器、引用或修订时读取。运行相关的快照与清理另见 [运行约束](runs.md)，设置与 Tool / Skill 的写边界另见 [能力约束](capabilities.md)。

## Repository layout

```
src/app/          Next 16 App Router: every page and every REST route; no middleware, no auth
  api/              route handlers, each `export const dynamic = "force-dynamic"`
  workflows/[id]/   xyflow canvas editor; editor.tsx only edits and launches: a started run goes to /runs/<id> (ADR-0018), the
                    canvas has no run bar, no switcher and no ?runId= deep link;
                    settings/ is the workflow-settings page (instructions, toggles, MCP subset,
                    skill set, Tool set — the middle tier of ADR-0016)
  runs/[id]/        the one place a run is watched: read-only canvas over the frozen runs.graph,
                    one time cursor (visuals-at.ts) driving nodes/edges, the round timeline and
                    the per-node drawer (trajectory / inputs-outputs / snapshot)
  monitor/          the system-health page: engine, database, disk, orphan runs and
                    entities, plus the manual cleanup panel — the whole of `/monitor`
src/instrumentation.ts   boot hook; the only server entry point that is not a route
src/rules.test.ts        mechanically checkable repository rules as vitest assertions
src/components/library/  list/folder/reference/revision UI the five library pages reuse
src/components/canvas/   flow-node.tsx / flow-edge.tsx plus the node model and the run-visuals
                         context both the editor and the run page render the graph through;
                         node-model.ts is also where PortKind / ReasoningEffort and their labels
                         live for everyone, the library pages included
src/db/           Drizzle schema + better-sqlite3 singleton (WAL, foreign_keys=ON)
src/lib/          pure, DB-free: graph.ts (validate/back-edge/exits), run-graph.ts (the shape
                  frozen into runs.graph + buildRunGraph/parseRunGraph), values.ts, http.ts, resume-match.ts,
                  workflow-settings.ts (toggle keys, effective-toggle merge, RunSettingsSnapshot),
                  tool-digest.ts (canonical JSON + Tool contract sha256),
                  trajectory-view.ts (the trajectory endpoint's display DTO, shared by the
                  server-side projection and the run page's drawer), and the four rule modules
                  the write boundary and its editor both call so neither copies the other:
                  skill-files.ts (skill resource limits + path rules), tool-names.ts (Tool public
                  name pattern, reserved names, publicNameProblem/toolCodeProblem),
                  json-schema-shape.ts (the object-root shape half of objectSchemaProblem),
                  list-query.ts (SORT_KEYS/DEFAULT_SORT/DEFAULT_PAGE_SIZE/MAX_PAGE_SIZE)
src/server/       server-only services; client code imports no value from here
  engine/           runner.ts (orchestration/cancel), action.ts (one node), events.ts (session
                    events → run_events/node_usage as they arrive), rounds.ts (the only writer of
                    run_node_rounds), reconcile.ts (startup)
  harness/          DeepSeek Harness absorption: composition.ts (the explicit per-run cordis.yml list), entries.ts
                    (entry factories and YAML rendering), identity.ts (RPC module identity), catalog.ts (PLUGIN_CATALOG: every upstream row's decision, group,
                    toggle and customization), workspace.ts + launch.ts (run directory, subprocess
                    + stdio JSON-RPC), trajectory.ts, tool-contract.ts (the ctx surface a Tool
                    author sees) + tool-plugin.ts (the cordis wrapper a Tool is materialized into),
                    and rpc/ (the cordis plugin the subprocess loads). catalog.test.ts pins
                    catalog ↔ composition ↔ docs/harness; composition-boot.test.ts really boots
                    the default composition, and one carrying a sample contract Tool, in a
                    subprocess. The @deepseek-ai closure is imported only here
  writers/          per-library write<Kind>() + registry + list.ts query contract + used-by guard
  monitor/          health.ts + disk.ts read-only aggregation; cleanup.ts is the one
                    destructive path (deletes run_events and runs rows and data/runs/<id>, and
                    blanks the round rows' payload columns; dryRun previews it)
  folders.ts references.ts revisions.ts resolve.ts fs-safety.ts settings.ts pricing.ts
  skill-library.ts resume-match*.ts run-rounds.ts (where the round row's skeleton /
  payload split is defined once, for both readers)
scripts/seed.ts   idempotent platform baseline only: the three builtin Object Types and the
                  models rows; case content is seed-resume.ts / seed-leetcode.ts
e2e/              Playwright specs + helpers.ts (fixture builders + prefix-scoped cleanup)
docs/             DESIGN.md (v1 + engine spec), DESIGN-V2.md (v2 contracts), DESIGN-V3.md (the
                  2026-09 cleanup / run-page / toolchain contract with its progress table),
                  development/ (task-specific engineering guidance),
                  simplifications/ (one evidence-backed record per simplification candidate:
                  proposed / done / rejected; its README owns the rules), adr/, harness/ (the
                  per-row review record of the upstream composition: README + one file per
                  catalog group + its own AGENTS.md with the upstream-upgrade procedure),
                  artifacts/ (one-off paid-acceptance records: the SHA-256 and usage evidence
                  of one real run, referenced from nowhere in the tree)
.github/          workflows/ci.yml (merge gate), smoke.yml (paid; manual or nightly), claude.yml
                  (@claude review); REVIEW.md (the review checklist); pull_request_template.md
.nvmrc            the Node major CI installs; package.json `engines` pins the same floor
data/             gitignored runtime root: ontoflow.db, runs/, uploads/, samples/, skills/
_reference/       gitignored third-party source, excluded from tsconfig; never import or edit
```

`.data/` is unrelated private residue with no code reference. Do not read or write it.

## Conventions

- Every API route body runs inside `handle()` from `@/lib/http`, and an HTTP method is an exported function declaration whose first statement is `return handle(` — never a `const`, an alias, or a re-export, because that one shape is what lets `src/rules.test.ts` decide the rule by reading the file. One does not: `api/runs/[id]/events` returns a raw SSE `Response` — do not copy it.

- **Name collisions are a database concern.** `handle()` maps `UNIQUE constraint failed` to 409, so writers never pre-check a name; folders are the exception, because SQLite cannot constrain a root level whose parent is NULL ([reason](../../src/db/schema.ts)).

- **Entity-body validation lives in the writer's `parse…Payload`** (workflow's is `parseGraphPayload`); a route hand-narrows only its own non-entity params. All of it is hand-written `typeof` narrowing — there is no schema library.

- **Write paths return a result object; the engine throws.** `runner.ts` turns a thrown error into `run_nodes.error` plus skipped downstream nodes. Every entity write path returns `WriteResult` with `writeOk`/`writeFail` from `@/server/writers/types` — the five writers, `settings.ts`, `resume-match.ts`, `folders.ts` and `revisions.ts`, with no private copy of the shape left; a route whose success body is exactly `result.data` answers with that module's `respond()` rather than unpacking by hand. `fs-safety.ts` and `monitor/cleanup.ts` throw deliberately and their callers map the throw.

- **better-sqlite3 is synchronous.** Drizzle calls end in `.get()` / `.all()` / `.run()`; never `await db.…`.

- Raw SQL goes through drizzle's `sql` tag — both spellings, `sql\`…\`` and `sql<T>\`…\``, imported from `drizzle-orm` under that name (no `sql as …`, no namespace import, or the allowlist scan is dodged by renaming) — and only where the query builder cannot express the aggregate: `monitor/` (cleanup, health), `writers/list.ts` (the `LIKE` search), `engine/action.ts` (the per-session `SUM` rollup), `engine/events.ts` (the `json_extract` tool-name lookup), `revisions.ts` (`max(version_no)`), and `api/runs/route.ts` (the per-run totals, the filter-set usage summary, and the `json_extract` source projection); `src/rules.test.ts` pins that allowlist and asserts every listed file still needs it. User input inside `LIKE` is escaped and paired with `escape '\'`.

- Process-level mutable state is parked on `globalThis` under an `ontoflow`-prefixed key so HMR cannot lose it: `ontoflowDb`, `ontoflowCancelledRuns`, `ontoflowRunProcesses`, `ontoflowActiveRuns`, the usage-settlement maps, the skill-projection holds; `src/rules.test.ts` pins the prefix on every key. A module-level `const map = new Map()` is the bug this prevents.

- A server-module unit test assigns an in-memory database to `globalThis.ontoflowDb` and then `await import()`s the module under test; a static import reaches the real `data/ontoflow.db`.

- **There are no Server Actions.** Every mutation is a `fetch` to `/api/*`; new pages start with `"use client"` and load data in `useEffect`.

- Client code imports nothing from `@/server` or `@/db`, `import type` included; a type the client needs moves to `src/lib/` first.

- **The five library list GETs and `/api/runs` return `{ items, total, page, pageSize }`** — the library five built from `parseListQuery` + `selectLibraryPage` + `listEnvelope` in `src/server/writers/list.ts`, `/api/runs` assembling its own envelope (plus a `summary` of the whole filter set: `tokens` / `cost` summed from `run_nodes`, the authoritative per-node rollup, and only `byModel` from `node_usage`, which can lag by a chunk whose insert failed and was folded into `run_nodes` from memory) but taking its paging defaults and cap from that module's `parsePageQuery`, so the 30/100 numbers have one home. A run's entry is a read-time projection of `imports.invocation.source` — `/api/runs` derives `items[].source` and its `source=` filter with `json_extract`, coalescing a run with no invocation to `workflow`; the fact is not stored twice. Every other GET defines its own shape.

- The five library pages reuse `src/components/library/`; no page grows its own list, folder, reference, or revision UI — the enumeration is the whole surface, not four named components, because four byte-identical copies of the folder badge and the 409 wording once slipped through the gaps in a narrower list. Their filter state lives in the URL through `use-library-query`, never in component state.

- Workflows never enter folders; gate every folder path on `isFolderEntityKind`, not an ad-hoc comparison ([ADR-0005](../../docs/adr/0005-folders-not-tags.md)).

- **Delete protection is per-owner and there are exactly four.** The four referenceable libraries answer 409 through `usedByNames()`; workflow DELETE has its own running-run guard; folder DELETE has its own name-collision guard; run DELETE refuses a running run with 409 through `deleteRun` in `monitor/cleanup.ts` — the destructive path stays in that one module. Do not add a fifth, and do not hand-write a reference join — `src/server/references.ts` is the only module that joins references, and its fact table is: Action ← `workflow_nodes.action_id`, Skill ← `workflow_skills`, Tool ← `workflow_tools`, Object Type ← `action_ports` + `workflow_nodes`. A Skill or Tool is referenced by a **workflow** (detail 「技能集」 / 「Tool 集」, href `/workflows/<id>/settings`), never by an Action: an Action's preloads and visible Tools are a selection inside a set the workflow already references, so they are not references and delete protection does not look at them.

- **Every entity write records a revision inside the same transaction**, capturing the complete definition including relations (an Action's ports, `preloadSkillIds` and `toolIds`; a Skill's `files`; a Tool's whole contract; a workflow's `instructions`, `settings`, `skillIds`, `toolIds`, nodes and edges), and rollback replays the same `write<Kind>()`; a route that can reach revision restore carries `import "@/server/writers";` or restore silently answers 501.

- Untrusted paths pass through `@/server/fs-safety` (`isWithinData` at the request boundary, `resolveWithinData` and `safeBasename` at use); the run subprocess reads and writes whatever is in its workspace.

- Ids are `crypto.randomUUID()` from the schema default; a caller supplies an id only when it must return that id before insert or preserve client-side edge references.

- **A canvas node is a reference to the shared Action**, so editing it from the canvas edits that Action everywhere ([ADR-0004](../../docs/adr/0004-canvas-edits-the-shared-action.md)).

- Input and output node ports are always named `"value"`.
