/**
 * Workflow 图的校验、回边判定与出口分组。纯函数，不接触数据库。
 * 节点在进入本模块前已被解析为带端口类型信息的 ResolvedNode。
 *
 * 图不再是 DAG（ADR-0009）：
 * - 一个输出端口连出多条线就是扇出，一个输入端口接进多条线就是汇总；
 * - 出口端口连回上游即构成循环，被回流的 Action 自己声明重入上限。
 * 因此这里不再有拓扑排序——调度由引擎按就绪状态驱动，本模块只回答
 * 「哪些边是回边」「图合不合法」。
 */

export interface ResolvedPort {
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: "text" | "file" | "json";
  /**
   * 输出端口所属的出口名。null 表示默认出口——节点没有分支，全部输出恒生效。
   * 一旦有具名出口，该 Action 的每个输出端口都必须归属某个出口。
   */
  exitName?: string | null;
  /** 输出端口的产物路径（相对运行工作区） */
  artifactPath?: string | null;
}

export interface ResolvedNode {
  id: string;
  kind: "action" | "input" | "output";
  label: string;
  /** input 节点：唯一输出端口 value；output 节点：唯一输入端口 value */
  inputs: ResolvedPort[];
  outputs: ResolvedPort[];
  /** Action 最多被回流重入几次；0 表示不可重入，不能作为回边的目标 */
  maxReentries?: number;
  /** 重入次数耗尽时的收束方式 */
  onExhausted?: "fail" | "accept";
}

/**
 * 重入上限的写边界上限。一轮开一个会话目录，而 `readAgentTrajectory` 读到第
 * `MAX_SESSION_FILES`（128，src/server/harness/trajectory.ts）个就抛——上限再高，
 * 轨迹页签会整块打不开。留出余量封在 100；写边界（`parseActionPayload`）与 Action
 * 编辑器读同一个常量，客户端不能从 `@/server` 引运行时值，所以它落在这个纯模块里。
 */
export const MAX_REENTRIES = 100;

/**
 * 一个节点在一次运行里允许的总轮次上限。与 `MAX_REENTRIES` 同源同值：一轮开一个会话目录，
 * `readAgentTrajectory` 读到第 `MAX_SESSION_FILES`（128）个就抛。
 *
 * `MAX_REENTRIES` 管的是**单个回边目标**被打回几次，管不住总轮次：嵌套或重叠的环体各自
 * 在限额内重入，夹在中间的下游 Action 会被反复重置，轮次一路涨到轨迹面板打不开。
 * 执行器给节点分配下一个轮次号时按这个上限收口整条运行。
 */
export const MAX_NODE_ROUNDS = 100;

export interface GraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export interface ValidationIssue {
  nodeId?: string;
  edgeId?: string;
  message: string;
}

/** 一个 Action 的一个具名出口及其全部输出端口。 */
export interface NodeExit {
  /** null 表示默认出口 */
  name: string | null;
  ports: ResolvedPort[];
}

/**
 * 按出口名给节点的输出端口分组，顺序稳定（默认出口在前，其余按名字排序）。
 * 只有一个出口时该出口恒被选中，节点没有分支语义。
 */
export function exitsOf(node: ResolvedNode): NodeExit[] {
  const byName = new Map<string | null, ResolvedPort[]>();
  for (const port of node.outputs) {
    const key = port.exitName ?? null;
    const list = byName.get(key) ?? [];
    list.push(port);
    byName.set(key, list);
  }
  return [...byName.entries()]
    .sort((a, b) => {
      if (a[0] === b[0]) return 0;
      if (a[0] === null) return -1;
      if (b[0] === null) return 1;
      return a[0] < b[0] ? -1 : 1;
    })
    .map(([name, ports]) => ({ name, ports }));
}

/** 节点是否有多个具名出口——有才需要在数据面报告走了哪个。 */
export function hasNamedExits(node: ResolvedNode): boolean {
  return node.outputs.some((p) => (p.exitName ?? null) !== null);
}

/**
 * 从入口节点出发做稳定 DFS，把指向「当前仍在栈上的节点」的边判为回边。
 *
 * 之所以要显式判定而不是遇环报错：回边不参与就绪判断。若一个环里的节点
 * 既等前驱又等回边，它第一轮永远等不齐，整张图当场死锁。
 * 遍历顺序按节点 id 与边 id 排序，同一张图每次得到同一组回边——
 * 判定结果是校验信息的一部分，作者要能看见系统认为哪条线是回边。
 */
export function classifyEdges(
  nodes: ResolvedNode[],
  edges: GraphEdge[],
): { backEdgeIds: Set<string> } {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const node of nodes) outgoing.set(node.id, []);
  const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const edge of sorted) outgoing.get(edge.sourceNodeId)?.push(edge);

  const backEdgeIds = new Set<string>();
  const state = new Map<string, "visiting" | "done">();

  const visit = (nodeId: string): void => {
    state.set(nodeId, "visiting");
    for (const edge of outgoing.get(nodeId) ?? []) {
      const next = state.get(edge.targetNodeId);
      if (next === "visiting") {
        backEdgeIds.add(edge.id);
        continue;
      }
      if (next === undefined) visit(edge.targetNodeId);
    }
    state.set(nodeId, "done");
  };

  const hasIncoming = new Set(edges.map((e) => e.targetNodeId));
  const roots = nodes
    .filter((n) => !hasIncoming.has(n.id))
    .map((n) => n.id)
    .sort();
  for (const id of roots) if (!state.has(id)) visit(id);
  // 全在环里、没有入口的子图也要遍历到，否则它的回边判不出来。
  for (const node of [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!state.has(node.id)) visit(node.id);
  }
  return { backEdgeIds };
}

export function validateGraph(nodes: ResolvedNode[], edges: GraphEdge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  if (nodes.length === 0) {
    issues.push({ message: "工作流为空" });
    return issues;
  }

  const connections = new Set<string>();
  for (const edge of edges) {
    const key = JSON.stringify([
      edge.sourceNodeId,
      edge.sourcePort,
      edge.targetNodeId,
      edge.targetPort,
    ]);
    if (connections.has(key)) issues.push({ edgeId: edge.id, message: "这两个端口之间已经有连线" });
    connections.add(key);
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);
    if (!source || !target) {
      issues.push({ edgeId: edge.id, message: "连线指向不存在的节点" });
      continue;
    }
    const sourcePort = source.outputs.find((p) => p.name === edge.sourcePort);
    const targetPort = target.inputs.find((p) => p.name === edge.targetPort);
    if (!sourcePort) {
      issues.push({
        edgeId: edge.id,
        message: `节点「${source.label}」没有输出端口「${edge.sourcePort}」`,
      });
      continue;
    }
    if (!targetPort) {
      issues.push({
        edgeId: edge.id,
        message: `节点「${target.label}」没有输入端口「${edge.targetPort}」`,
      });
      continue;
    }
    // ADR-0002 经 ADR-0008 修订：对象类型是产物的契约类型，同名才能连，
    // 约束只在编辑期成立——运行时没有任何机制核对文件里真的写了它声称的东西。
    if (sourcePort.objectTypeId !== targetPort.objectTypeId) {
      issues.push({
        edgeId: edge.id,
        message: `类型不匹配：「${source.label}.${sourcePort.name}」是 ${sourcePort.objectTypeName}，「${target.label}.${targetPort.name}」要求 ${targetPort.objectTypeName}`,
      });
    }
  }

  // 输入端口可以接多条入线（那就是汇总），但不能一条都没有：没有入线的口永远喂不上。
  const incoming = new Set(edges.map((e) => `${e.targetNodeId} ${e.targetPort}`));
  for (const node of nodes) {
    for (const port of node.inputs) {
      if (!incoming.has(`${node.id} ${port.name}`)) {
        issues.push({
          nodeId: node.id,
          message: `节点「${node.label}」的输入端口「${port.name}」未连线`,
        });
      }
    }
  }

  // 具名出口要么全有要么全无：一半有名字一半没有，「选中哪个出口」就没有答案。
  for (const node of nodes) {
    if (node.kind !== "action" || node.outputs.length === 0) continue;
    const named = node.outputs.filter((p) => (p.exitName ?? null) !== null).length;
    if (named !== 0 && named !== node.outputs.length) {
      issues.push({
        nodeId: node.id,
        message: `节点「${node.label}」的输出端口有的归属具名出口、有的没有；要么都归属，要么都不归属`,
      });
    }
  }

  // 回边的目标必须声明了重入上限，否则这个循环没有出口，只能一直转下去。
  const { backEdgeIds } = classifyEdges(nodes, edges);
  for (const edge of edges) {
    if (!backEdgeIds.has(edge.id)) continue;
    const target = nodeById.get(edge.targetNodeId);
    if (!target) continue;
    if ((target.maxReentries ?? 0) < 1) {
      issues.push({
        edgeId: edge.id,
        nodeId: target.id,
        message: `这是一条回边，但被回流的节点「${target.label}」没有声明重入上限，循环无法收束`,
      });
    }
  }

  return issues;
}

/**
 * 编辑过程允许尚未接齐的图，只拒绝本次添加新引入的连线错误。
 * 整图保存和拖线使用同一套规则；新增边可能把已有边重判为回边，不能只查候选边自身。
 * 候选 id 必须沿用到实际添加，稳定 DFS 的结果才不会在松开指针后改变。
 */
export function connectionProblem(
  nodes: ResolvedNode[],
  edges: GraphEdge[],
  candidate: GraphEdge,
): ValidationIssue | undefined {
  const key = (issue: ValidationIssue) => JSON.stringify([issue.edgeId, issue.message]);
  const previous = new Set(validateGraph(nodes, edges).map(key));
  return validateGraph(nodes, [...edges, candidate]).find(
    (issue) => issue.edgeId && (issue.edgeId === candidate.id || !previous.has(key(issue))),
  );
}

/** 某节点失败后，其所有下游（传递闭包）应标记 skipped。回边不参与，否则闭包会吞掉整个环。 */
export function downstreamOf(
  startId: string,
  edges: GraphEdge[],
  backEdgeIds: Set<string> = new Set(),
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (backEdgeIds.has(edge.id)) continue;
    const list = adjacency.get(edge.sourceNodeId) ?? [];
    list.push(edge.targetNodeId);
    adjacency.set(edge.sourceNodeId, list);
  }
  const result = new Set<string>();
  const queue = [...(adjacency.get(startId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(adjacency.get(id) ?? []));
  }
  return result;
}
