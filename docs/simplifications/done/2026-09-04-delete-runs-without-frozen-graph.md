# 简化：删掉 ADR-0018 之前没有冻结图的历史运行——没法回放的记录不需要保留

状态: done

## 问题

[ADR-0018](../../adr/0018-run-page-frozen-graph-replay.md) 之后，运行页只画受理时冻结进 `runs.graph` 的图，
按 `run_node_rounds` 回放。早于那一列的运行拿到的是默认空图（`EMPTY_RUN_GRAPH`），也没有轮次行：运行页
画布是空的，只能从时间轴行名打开抽屉看轨迹（`e2e/runs.spec.ts`「早于冻结图的运行」用例描述的正是这个
降级形态）。没有兼容分支——渲染走同一条路，只是无物可画。

2026-09-04 清点本机 `data/ontoflow.db`：

```
select count(*) from runs;                                                     → 50
select status, count(*) from runs
  where json_array_length(json_extract(graph,'$.nodes')) = 0 group by status;  → success 42 / failed 5 / cancelled 1
select count(*) from runs r where … = 0
  and exists(select 1 from run_node_rounds x where x.run_id = r.id);           → 0
select count(*) from runs where json_array_length(json_extract(graph,'$.nodes')) > 0;  → 2
select count(*) from runs where status = 'running';                            → 0
```

48 条都是 2026-09-01 至 09-03 的冒烟运行（引擎冒烟·两节点线性 / 图冒烟·扇出汇总与回边 /
能力冒烟·技能与工具），全部早于冻结图，全部没有轮次行。

**生产消费者：** 运行列表与 `/api/runs` 的汇总把它们计入运行数与费用；运行页对它们只能空画布回放。
**测试 / 文档消费者：** 无——CI 的 e2e 库没有历史运行，`runs.spec.ts` 的 legacy 用例用自己合成的夹具。

**打败了哪条已记录的理由：** `AGENTS.md`「Runs admitted before that column get the default empty graph and
render through the same path; there is no legacy branch」说的是**代码**不留分支，没有说数据要留。用户拍板：
「没法回放的历史记录不需要记录」。

## 提议

不改代码。对 48 条运行逐条调 `DELETE /api/runs/[id]`——仓库唯一的破坏性路径 `deleteRun`
（`src/server/monitor/cleanup.ts`）：删 `runs` 行（级联 `run_nodes` / `run_node_rounds` / `run_events` /
`node_usage` / `run_results`）并删 `data/runs/<工作流>/<运行>/` 目录；正在运行的会答 409，本次没有。

连带：`find-simplifications` skill 新增「新功能上线后遗留的旧数据」一类候选与清点第 6 步，先例链到本记录
（PR #30）。`AGENTS.md` / REVIEW / DESIGN 不改。

## 放弃了什么

这 48 次冒烟的轨迹 JSONL、事件行、用量行与工作区产物；运行列表的费用汇总从此不含它们。它们没有一次是
业务运行（简历匹配 / LeetCode 案例的运行史早已随引擎替换失效），付费冒烟随时能重新跑出同类记录。

## 验收

- 删前 `/api/runs?pageSize=1` 的 `total` 与 SQLite 计数一致（50），否则停手。
- 48 次 DELETE 全部 200；删后 `runs` 剩 2 行、无冻结图的为 0；被删 id 在 `data/runs/*/` 下无残留目录。
- 剩下两条运行（引擎冒烟、图冒烟，2026-09-03 17:34）能在运行页正常回放。

## 风险

不可恢复；但删的是可重新生成的冒烟记录，且删前核对过没有 running 行、没有轮次行。运行页的 legacy 渲染路
与 `runs.spec.ts` 的 legacy 用例保留——那是代码对空图的行为，不是兼容层；要不要在下一轮把那条用例也
删掉，另作候选。

## 落地

2026-09-04，对 3592 上的 dev server（从仓库根目录启动，读 `data/ontoflow.db`）逐条 `curl -X DELETE`：

```
48 × HTTP 200
runs: 50 → 2；无冻结图: 48 → 0；run_node_rounds 15 / run_events 178 / node_usage 45（都属于剩下两条）
被删 id 的运行目录残留: 0
```

与提议无差异。决定与数量同时写进 `find-simplifications` skill 的候选清单（PR #30）。
