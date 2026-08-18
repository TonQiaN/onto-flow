# AGENTS.md

OntoFlow is a single-process local workbench: reusable Actions wired into DAG workflows, each Action node executed in its own session on a local opencode server. Read [CONTEXT.md](CONTEXT.md) before naming anything.

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
src/lib/          pure, DB-free: graph.ts (validate/topo/downstream), values.ts, http.ts
src/server/       server-only services; client code imports no value from here
  engine/           runner.ts (orchestration/cancel), action.ts (one node), reconcile.ts (startup)
  opencode/         server singleton, per-workspace event pump, usage rollup;
                    the SDK is imported only here and in engine/action.ts
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

Run everything from the repository root: `data/` resolves from `process.cwd()` in `src/db/index.ts`, `src/server/fs-safety.ts`, `src/server/opencode/server.ts`, and `drizzle.config.ts`, so another working directory is another database. The opencode CLI (>= 1.18) must be on PATH; `getOpencodeUrl` reuses whatever already answers on `127.0.0.1:4977` instead of spawning a second one, and a reused server keeps the `opencodeConfig` and `ONTOFLOW_DB_PATH` of whoever spawned it — both arrive as spawn-time environment and cannot be changed afterwards. Run `lsof -ti tcp:4977 | xargs kill` after editing `opencodeConfig`, or when an opencode from another working directory may hold the port: otherwise new variants are silently inert and a Tool writes into another database.

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
```

### Checks

Nothing runs on commit, push, or pull request: there is no CI, no git hook, no linter, and no formatter. These commands are the entire gate, and running them is your responsibility.

- Run `npm run check` before declaring work done; add `npm run build` when the change touches `src/app/`, `next.config.ts`, or `tsconfig.json`, because `build` catches route and config breakage `typecheck` misses.
- `next.config.ts` carries two pins a dependency change breaks: a new native or server-only package must join `serverExternalPackages`, and the Turbopack `root` pin is what stops Next latching onto a lockfile outside the repository.
- Unit tests are `*.test.ts` under `src/` or `scripts/`; everything under `e2e/` is Playwright, and the two globs do not overlap. `vitest.config.ts` re-declares the `@/*` alias, so a service test that bypasses it cannot resolve `@/db`.
- Unit tests cover pure logic and non-obvious invariants — today `src/lib/graph.ts` and `src/server/folders.ts`; everything user-visible is covered by Playwright.
- `test:e2e` starts a dev server or attaches to whatever already listens on 3592 (`reuseExistingServer`), so confirm that server was launched from the repository root or you are testing another database. A user-visible change runs its one matching spec, not the suite.

### Test fixtures are unrecoverable

`db:seed` writes the five libraries, their folders, a v1 revision each, the two `models` rows, and `data/samples/采购需求示例.txt` — and nothing else: no runs, no run_events, no node_usage, no purchase_plans. The run history, archived documents, and cost figures that `runs.spec.ts`, `documents.spec.ts`, and `monitor.spec.ts` assert against exist only in the gitignored local `data/ontoflow.db`, produced by paid real runs.

- Never delete `data/ontoflow.db`, never call `POST /api/monitor/cleanup` with `dryRun: false`, and never click 执行清理: the fixture cannot be regenerated without spending money.
- E2E never starts a workflow run and never clicks 执行清理 / 确认删除 / 中止该运行; the cleanup panel is exercised only through `dryRun`.
- E2E creates entities under a per-spec `e2e-` Chinese prefix and removes them in teardown through `cleanupByPrefix`, which skips `builtin` rows and re-checks the prefix.
- Never assert a count, a first-page containment, or an exact row that real usage grows: wait for the API response and assert the DOM matches its payload. This bug class has already been fixed twice.

## Conventions

- User-facing strings, error messages, code comments, and test names are Chinese; identifiers are English.
- Every API route body runs inside `handle()` from `@/lib/http`. Four do not: `api/monitor/stream` and `api/runs/[id]/events` return a raw SSE `Response`, and `api/models` and `api/documents` are one-statement GETs that predate the rule — do not copy them.
- **Name collisions are a database concern.** `handle()` maps `UNIQUE constraint failed` to 409, so writers never pre-check a name; folders are the exception, because SQLite cannot constrain a root level whose parent is NULL ([reason](src/db/schema.ts)).
- **Entity-body validation lives in the writer's `parse…Payload`** (workflow's is `parseGraphPayload`); a route hand-narrows only its own non-entity params. All of it is hand-written `typeof` narrowing — there is no schema library.
- **Write paths return a result object; the engine throws.** `runner.ts` turns a thrown error into `run_nodes.error` plus skipped downstream nodes. New service modules use `WriteResult` with `writeOk`/`writeFail` from `@/server/writers/types`; `folders.ts` and `revisions.ts` still carry private structurally identical `Result<T>` copies — converge on `WriteResult`, never add a fourth. `fs-safety.ts` and `monitor/cleanup.ts` throw deliberately and their callers map the throw.
- **better-sqlite3 is synchronous.** Drizzle calls end in `.get()` / `.all()` / `.run()`; never `await db.…`.
- Raw SQL goes through drizzle's `sql` tag and only where the query builder cannot express the aggregate: `monitor/`, `writers/list.ts`, `revisions.ts`, `opencode/server.ts`, `api/runs/route.ts`. User input inside `LIKE` is escaped and paired with `escape '\'`.
- Process-level mutable state is parked on `globalThis` under an `ontoflow`-prefixed key so HMR cannot lose it: `ontoflowDb`, `ontoflowOpencodeServer`, `ontoflowCancelledRuns`, `ontoflowSessionRoutes`, `ontoflowSessionPumps`, `ontoflowSessionErrors`, and the delta buffers. A module-level `const map = new Map()` is the bug this prevents.
- A server-module unit test assigns an in-memory database to `globalThis.ontoflowDb` and then `await import()`s the module under test; a static import reaches the real `data/ontoflow.db`.
- **There are no Server Actions.** Every mutation is a `fetch` to `/api/*`; new pages start with `"use client"` and load data in `useEffect`.
- Client code imports no runtime value from `@/server` or `@/db`. `import type` from `@/server/monitor/types` is the sanctioned exception, and that module's own `import type { NodeStatus, RunStatus } from "@/app/runs/lib"` is the one accepted reverse dependency.
- **All five library list GETs return `{ items, total, page, pageSize }`**, built from `parseListQuery` + `selectLibraryPage` + `listEnvelope` in `src/server/writers/list.ts`. Every other GET defines its own shape.
- The five library pages reuse `src/components/library/`; no page grows its own tree, toolbar, folder picker, or revision panel. Their filter state lives in the URL through `use-library-query`, never in component state.
- Workflows never enter folders; gate every folder path on `isFolderEntityKind`, not an ad-hoc comparison ([ADR-0005](docs/adr/0005-folders-not-tags.md)).
- **Delete protection is per-owner and there are exactly three.** The four referenceable libraries answer 409 through `usedByNames()`; workflow DELETE has its own running-run guard; folder DELETE has its own name-collision guard. Do not add a fourth, and do not hand-write a reference join — `src/server/references.ts` is the only module that joins references.
- **Every entity write records a revision inside the same transaction**, capturing the complete definition including relations, and rollback replays the same `write<Kind>()`; a route that can reach revision restore carries `import "@/server/writers";` or restore silently answers 501.
- Untrusted paths pass through `@/server/fs-safety` (`isWithinData` at the request boundary, `resolveWithinData` and `safeBasename` at use); opencode executes whatever lands in a run workspace.
- Ids are `crypto.randomUUID()` from the schema default; a caller supplies an id only when it must return that id before insert or preserve client-side edge references.
- **Nominal port typing is a runtime rule, not a TypeScript one.** Two ports connect only when their `objectTypeId` values are equal ([ADR-0002](docs/adr/0002-nominal-port-typing.md)); ids stay bare `string`.
- **A canvas node is a reference to the shared Action**, so editing it from the canvas edits that Action everywhere ([ADR-0004](docs/adr/0004-canvas-edits-the-shared-action.md)).
- Input and output node ports are always named `"value"`.
- A Tool's `code` is a standalone opencode custom tool that Bun executes inside the node workspace. It cannot import anything from this repository; it reaches SQLite through `bun:sqlite` and `process.env.ONTOFLOW_DB_PATH`, shares that file with the Next process, and therefore sets `busy_timeout` and stays write-light.
- Adding or changing a model is a two-file change: `opencodeConfig` in `src/server/opencode/server.ts` declares the four reasoning-effort `variants` — the only channel by which 思考强度 reaches the model — and `upsertModel` in `scripts/seed.ts` populates the `models` table. No route writes `models`, and a model without declared variants has no effort levels.

### The opencode seam

Every rule here was learned from a production failure. Read the header comments of `src/server/opencode/server.ts` and `src/server/engine/action.ts`, and the engine spec in [docs/DESIGN.md](docs/DESIGN.md), before touching sessions, events, usage, or cancellation.

- **All opencode traffic goes through `longHaulFetch`.** Node's undici severs a model turn past its default header and body timeouts, and Next's patched `globalThis.fetch` silently drops the `dispatcher` field.
- **Because that client is unbounded, every non-generating call carries its own `AbortSignal.timeout`**; only the generation prompts run unbounded, and cancellation is their timeout.
- Pass `directory` on every session call and subscribe the event pump per workspace: opencode scopes its event stream by directory, so a global subscription receives nothing and an abort without it never lands.
- **Structured output is a prompt convention.** Do not use opencode's `format: json_schema`: it is implemented with a synthetic tool plus `tool_choice: required`, which the reasoning models in use reject with 400.
- Token usage is upserted by `(sessionId, messageId)` and rolled up with `SUM`; one assistant message emits `message.updated` repeatedly, so incrementing counts it many times over.
- **The run snapshot is written before the session is created**, from ports re-read at execution time; a run whose ports changed mid-flight aborts rather than produce output the snapshot cannot explain.
- **`cancelled` is a terminal state distinct from `failed`** and leaves `run.error` null; a prompt that throws after cancellation is cancelled, not failed.
- **A run never stays `running`.** Terminal state is written by `executeRun`, by `cancelRun`, by `failWholeRun`, and at process start by `reconcileOrphanRuns` through `src/instrumentation.ts`.
- Both SSE endpoints poll SQLite; there is no in-process pubsub, and the run stream ends only after three silent ticks past terminal state.

## Comments and documentation

A comment that records why a workaround exists is the rule itself — `longHaulFetch`, the per-workspace event pump, the `SUM` rollup, `LIKE` escaping, the quiet-tick stream ending — so deleting the comment deletes the rule. Comments state behavior, failure, timing, and ownership in Chinese; they do not narrate control flow or restate code. Every remaining `any` carries a comment naming why narrowing is infeasible. When a change alters a contract that [docs/DESIGN.md](docs/DESIGN.md) or [docs/DESIGN-V2.md](docs/DESIGN-V2.md) states, or settles a term, update that document in the same change.

## Decisions and the glossary

- [CONTEXT.md](CONTEXT.md) owns domain vocabulary and semantics only; keep implementation out of it and update it the moment a term is settled.
- [docs/DESIGN.md](docs/DESIGN.md) owns the v1 contract and the opencode engine spec; [docs/DESIGN-V2.md](docs/DESIGN-V2.md) owns the list, folder, reference, revision, and shared-UI contracts.
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
