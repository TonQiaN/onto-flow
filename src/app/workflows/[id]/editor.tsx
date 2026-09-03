"use client";
import { fetchAllPages } from "@/components/library/fetch-all-pages";

/**
 * 画布编辑器主体：@xyflow/react v12。
 *
 * - 单一自定义 nodeType（flow-node.tsx 内部按 data.kind 分发）
 * - isValidConnection 用 store.getState() 取最新图（防 stale 闭包）：
 *   同 objectTypeId + 目标输入端口无入线 + getOutgoers DFS 防环
 * - 拖线时把源端口信息放进 CanvasStateProvider，节点据此高亮可接端口、淡化其余端口
 * - 双击 Action 节点 → ActionInspector 编辑**共享 Action**（ADR-0004），
 *   保存后就地刷新画布上引用它的全部节点，不动视口；检查器的预载 / 可见 Tool 候选
 *   收窄到本工作流的技能集与 Tool 集（ADR-0016），集合在 /workflows/[id]/settings 里改
 * - 保存 = PUT 整图（toNodeDto/toEdgeDto 白名单序列化，剥 `_` 瞬态字段）；
 *   只发 name/description/nodes/edges，指令、开关、MCP 子集与两个集合由服务端沿用现值
 * - 运行 = 自动保存 → 收集输入 → POST run → 跳运行页；编辑器只编排与发起，
 *   看运行只有 /runs/<id> 一个地方（ADR-0018）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  addEdge,
  getOutgoers,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnConnectStart,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { readError } from "@/components/library";
import type { ValidationIssue } from "@/lib/graph";
import type { PortValue } from "@/lib/values";
import { CanvasStateProvider, type ConnectingState } from "@/components/canvas/canvas-state";
import { FlowEdgeView } from "@/components/canvas/flow-edge";
import { FlowNodeView } from "@/components/canvas/flow-node";
import type { FlowNode } from "@/components/canvas/node-model";
import { ActionInspector, type InspectorTarget } from "./action-inspector";
import { ACTION_DRAG_MIME, NodePanel } from "./node-panel";
import { RunDialog, type RunInputSpec } from "./run-dialog";
import {
  actionMeta,
  actionPortSnapshots,
  applyActionToNode,
  buildFlowEdges,
  buildFlowNodes,
  pruneEdges,
  toEdgeDto,
  toNodeDto,
  type ActionDto,
  type ActionItem,
  type ModelRow,
  type ObjectTypeRow,
  type SkillRow,
  type ToolRow,
  type WorkflowDetail,
  type WorkflowSets,
} from "./types";

const nodeTypes = { flowNode: FlowNodeView };
// 模块级常量：放进组件体会每帧新建对象，导致 React Flow 反复重建边
const edgeTypes = { flowEdge: FlowEdgeView };
const defaultEdgeOptions = { type: "flowEdge" as const };

const MINIMAP_COLOR: Record<string, string> = {
  action: "#a1a1aa",
  input: "#7dd3fc",
  output: "#6ee7b7",
};

/** 对齐辅助线的吸附判定阈值（画布坐标） */
const GUIDE_TOLERANCE = 5;

/** Shift 留给框选（selectionKeyCode 默认值），多选只认 ⌘/Ctrl */
const MULTI_SELECT_KEYS = ["Meta", "Control"];

interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string | null;
}

export function Editor({ workflowId }: { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner workflowId={workflowId} />
    </ReactFlowProvider>
  );
}

function EditorInner({ workflowId }: { workflowId: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [objectTypes, setObjectTypes] = useState<ObjectTypeRow[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  /** 本工作流的技能集与 Tool 集：随每次 GET/PUT 响应刷新，检查器据此收窄候选 */
  const [sets, setSets] = useState<WorkflowSets>({ skillIds: [], toolIds: [] });
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [runSpecs, setRunSpecs] = useState<RunInputSpec[] | null>(null);
  const [submittingRun, setSubmittingRun] = useState(false);
  const router = useRouter();

  // 画布交互态
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);
  const [snap, setSnap] = useState(false);
  const [boxSelect, setBoxSelect] = useState(false);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({
    v: [],
    h: [],
  });

  const wrapperRef = useRef<HTMLDivElement>(null);

  const storeApi = useStoreApi<FlowNode, Edge>();
  const { screenToFlowPosition, setCenter, getZoom, fitView } = useReactFlow<FlowNode, Edge>();

  const modelById = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const actionById = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);
  const issueNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of issues) if (issue.nodeId) ids.add(issue.nodeId);
    return ids;
  }, [issues]);

  // ---------- 加载 ----------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 库列表是分页信封（DESIGN-V2 第一节），画布要全量，翻到底而不是只取第一页
        const [wfRes, actRes, typeRes, modelRes, skillRes, toolRes] = await Promise.all([
          fetch(`/api/workflows/${workflowId}`),
          fetchAllPages<ActionItem>("/api/actions?sort=name_asc"),
          fetchAllPages<ObjectTypeRow>("/api/object-types?sort=name_asc"),
          fetch("/api/models"),
          fetchAllPages<SkillRow>("/api/skills?sort=name_asc"),
          fetchAllPages<ToolRow>("/api/tools?sort=name_asc"),
        ]);
        if (!wfRes.ok) throw new Error(await readError(wfRes));
        if (!actRes.ok) throw new Error(`Action 库读取失败（HTTP ${actRes.status}）`);
        if (!typeRes.ok) throw new Error(`对象类型库读取失败（HTTP ${typeRes.status}）`);

        const wf = (await wfRes.json()) as WorkflowDetail;
        const acts = actRes.items;
        const types = typeRes.items;
        // 模型 / Skill / Tool 只服务于检查器，取不到也不该拦住画布
        const modelRows = modelRes.ok ? ((await modelRes.json()) as ModelRow[]) : [];
        const skillRows = skillRes.ok ? skillRes.items : [];
        const toolRows = toolRes.ok ? toolRes.items : [];
        if (cancelled) return;

        setActions(acts);
        setObjectTypes(types);
        setModels(modelRows);
        setSkills(skillRows);
        setTools(toolRows);
        setName(wf.workflow.name);
        setDescription(wf.workflow.description ?? "");
        setSets({
          skillIds: wf.workflow.skillIds ?? [],
          toolIds: wf.workflow.toolIds ?? [],
        });
        setIssues(wf.issues ?? []);
        const flowNodes = buildFlowNodes(
          wf.nodes ?? [],
          new Map(acts.map((a) => [a.id, a])),
          new Map(types.map((t) => [t.id, t])),
          new Map(modelRows.map((m) => [m.id, m])),
        );
        setNodes(flowNodes);
        setEdges(buildFlowEdges(wf.edges ?? [], flowNodes));
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, setNodes, setEdges]);

  // 提示条自动淡出
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 有未保存改动时离开页面给出确认
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ---------- 改动追踪 ----------
  /**
   * 每次改动自增的版本号。保存是异步的，请求在途期间用户还能继续编辑；
   * 若返回后无条件 setDirty(false)，这些改动会被静默标记为「已保存」——
   * 用户以为存上了，离开时也不再提示。所以 persist 出手时记下版本号，
   * 只有版本号没变（期间没有新改动）才允许清掉 dirty。
   */
  const dirtyVersionRef = useRef(0);
  const markDirty = useCallback(() => {
    dirtyVersionRef.current += 1;
    setDirty(true);
  }, []);

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      onNodesChange(changes);
      // 选中/量尺寸不算改动，否则「未保存」会一直亮着
      if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) markDirty();
    },
    [onNodesChange, markDirty],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes);
      if (changes.some((c) => c.type !== "select")) markDirty();
    },
    [onEdgesChange, markDirty],
  );

  // ---------- 连线 ----------
  const isValidConnection: IsValidConnection<Edge> = useCallback(
    (conn) => {
      // 用 store 最新状态，绝不依赖渲染期闭包（Dify 模式）
      const { nodes: liveNodes, edges: liveEdges } = storeApi.getState();
      const source = liveNodes.find((n) => n.id === conn.source);
      const target = liveNodes.find((n) => n.id === conn.target);
      if (!source || !target || source.id === target.id) return false;

      const sourcePort = source.data.outputs.find((p) => p.name === (conn.sourceHandle ?? "value"));
      const targetPort = target.data.inputs.find((p) => p.name === (conn.targetHandle ?? "value"));
      if (!sourcePort || !targetPort) return false;
      // 严格 nominal 类型：Object Type id 相等才能连
      if (sourcePort.objectTypeId !== targetPort.objectTypeId) return false;
      // 目标输入端口最多一条入线
      if (
        liveEdges.some(
          (e) =>
            e.target === conn.target &&
            (e.targetHandle ?? "value") === (conn.targetHandle ?? "value"),
        )
      )
        return false;
      // getOutgoers DFS 防环：从 target 出发若能回到 source 则成环
      const hasCycle = (node: FlowNode, seen = new Set<string>()): boolean => {
        if (seen.has(node.id)) return false;
        seen.add(node.id);
        return getOutgoers(node, liveNodes, liveEdges).some(
          (o) => o.id === conn.source || hasCycle(o, seen),
        );
      };
      return !hasCycle(target);
    },
    [storeApi],
  );

  /** 拖线开始：记住源端口类型，让所有节点自己算「接不接得上」 */
  const onConnectStart: OnConnectStart = useCallback(
    (_event, params) => {
      const { nodes: liveNodes, edges: liveEdges } = storeApi.getState();
      const node = liveNodes.find((n) => n.id === params.nodeId);
      if (!node || !params.handleType) return;
      const portName = params.handleId ?? "value";
      const ports = params.handleType === "source" ? node.data.outputs : node.data.inputs;
      const port = ports.find((p) => p.name === portName);
      if (!port) return;
      const occupied = new Set(liveEdges.map((e) => `${e.target}:${e.targetHandle ?? "value"}`));
      setConnecting({
        nodeId: node.id,
        handleId: portName,
        handleType: params.handleType,
        objectTypeId: port.objectTypeId,
        occupied,
      });
    },
    [storeApi],
  );

  const onConnectEnd = useCallback(() => setConnecting(null), []);

  const onConnect = useCallback(
    (conn: Connection) => {
      const edge: Edge = {
        id: crypto.randomUUID(),
        source: conn.source,
        sourceHandle: conn.sourceHandle,
        target: conn.target,
        targetHandle: conn.targetHandle,
      };
      setEdges((eds) => addEdge(edge, eds));
      markDirty();
    },
    [setEdges, markDirty],
  );

  // ---------- 加节点 ----------
  const canvasCenter = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const point = rect
      ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const pos = screenToFlowPosition(point);
    return {
      x: pos.x + (Math.random() - 0.5) * 60,
      y: pos.y + (Math.random() - 0.5) * 60,
    };
  }, [screenToFlowPosition]);

  const addActionNode = useCallback(
    (action: ActionItem, position?: { x: number; y: number }) => {
      const ports = actionPortSnapshots(action);
      const node: FlowNode = {
        id: crypto.randomUUID(),
        type: "flowNode",
        position: position ?? canvasCenter(),
        data: {
          kind: "action",
          actionId: action.id,
          objectTypeId: null,
          label: action.name,
          inputs: ports.inputs,
          outputs: ports.outputs,
          _meta: actionMeta(action, modelById),
        },
      };
      setNodes((nds) => [...nds, node]);
      markDirty();
    },
    [canvasCenter, setNodes, modelById, markDirty],
  );

  const addIONode = useCallback(
    (kind: "input" | "output", type: ObjectTypeRow) => {
      const port = {
        name: "value",
        objectTypeId: type.id,
        objectTypeName: type.name,
        kind: type.kind,
        exitName: null,
      };
      const node: FlowNode = {
        id: crypto.randomUUID(),
        type: "flowNode",
        position: canvasCenter(),
        data: {
          kind,
          actionId: null,
          objectTypeId: type.id,
          label: kind === "input" ? `输入·${type.name}` : `输出·${type.name}`,
          inputs: kind === "output" ? [port] : [],
          outputs: kind === "input" ? [port] : [],
        },
      };
      setNodes((nds) => [...nds, node]);
      markDirty();
    },
    [canvasCenter, setNodes, markDirty],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const actionId = e.dataTransfer.getData(ACTION_DRAG_MIME);
      if (!actionId) return;
      const action = actionById.get(actionId);
      if (!action) return;
      addActionNode(action, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [actionById, addActionNode, screenToFlowPosition],
  );

  // ---------- 节点操作 ----------
  const duplicateNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => {
        const src = nds.find((n) => n.id === nodeId);
        if (!src) return nds;
        const copy: FlowNode = {
          ...src,
          id: crypto.randomUUID(),
          selected: false,
          position: { x: src.position.x + 48, y: src.position.y + 48 },
          data: { ...src.data },
        };
        return [...nds.map((n) => ({ ...n, selected: false })), copy];
      });
      markDirty();
    },
    [setNodes, markDirty],
  );

  const removeNodes = useCallback(
    (ids: string[]) => {
      const drop = new Set(ids);
      setNodes((nds) => nds.filter((n) => !drop.has(n.id)));
      setEdges((eds) => eds.filter((e) => !drop.has(e.source) && !drop.has(e.target)));
      markDirty();
    },
    [setNodes, setEdges, markDirty],
  );

  const focusNode = useCallback(
    (nodeId: string) => {
      const internal = storeApi.getState().nodeLookup.get(nodeId);
      if (!internal) return;
      const width = internal.measured.width ?? 240;
      const height = internal.measured.height ?? 120;
      void setCenter(
        internal.internals.positionAbsolute.x + width / 2,
        internal.internals.positionAbsolute.y + height / 2,
        { zoom: Math.max(getZoom(), 0.9), duration: 400 },
      );
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })));
    },
    [storeApi, setCenter, getZoom, setNodes],
  );

  /** 校验问题 → 定位：优先按节点，其次按连线的源节点 */
  const locateIssue = useCallback(
    (issue: ValidationIssue) => {
      if (issue.nodeId) {
        focusNode(issue.nodeId);
        return;
      }
      if (issue.edgeId) {
        const edge = storeApi.getState().edges.find((e) => e.id === issue.edgeId);
        setEdges((eds) => eds.map((e) => ({ ...e, selected: e.id === issue.edgeId })));
        if (edge) focusNode(edge.source);
      }
    },
    [focusNode, setEdges, storeApi],
  );

  const openInspector = useCallback(
    (nodeId: string) => {
      const node = storeApi.getState().nodes.find((n) => n.id === nodeId);
      if (!node || node.data.kind !== "action") return;
      const action = node.data.actionId ? actionById.get(node.data.actionId) : undefined;
      if (!action) {
        setBanner("这个节点引用的 Action 已被删除，请删除节点或换一个 Action");
        return;
      }
      setMenu(null);
      setInspector({ nodeId, action });
    },
    [storeApi, actionById],
  );

  // ---------- 对齐辅助线 ----------
  const updateGuides = useCallback(
    (dragged: FlowNode) => {
      const { nodeLookup } = storeApi.getState();
      const self = nodeLookup.get(dragged.id);
      if (!self) return;
      const selfW = self.measured.width ?? 240;
      const selfH = self.measured.height ?? 120;
      const selfX = [
        dragged.position.x,
        dragged.position.x + selfW / 2,
        dragged.position.x + selfW,
      ];
      const selfY = [
        dragged.position.y,
        dragged.position.y + selfH / 2,
        dragged.position.y + selfH,
      ];

      const v: number[] = [];
      const h: number[] = [];
      for (const other of nodeLookup.values()) {
        if (other.id === dragged.id) continue;
        const w = other.measured.width ?? 240;
        const ht = other.measured.height ?? 120;
        const ox = other.internals.positionAbsolute.x;
        const oy = other.internals.positionAbsolute.y;
        for (const candidate of [ox, ox + w / 2, ox + w]) {
          if (selfX.some((s) => Math.abs(s - candidate) <= GUIDE_TOLERANCE)) v.push(candidate);
        }
        for (const candidate of [oy, oy + ht / 2, oy + ht]) {
          if (selfY.some((s) => Math.abs(s - candidate) <= GUIDE_TOLERANCE)) h.push(candidate);
        }
      }
      setGuides({ v: [...new Set(v)], h: [...new Set(h)] });
    },
    [storeApi],
  );

  // ---------- 保存 ----------
  const persist = useCallback(
    async (graph?: {
      nodes: FlowNode[];
      edges: Edge[];
    }): Promise<{ ok: boolean; issues: ValidationIssue[] }> => {
      setSaving(true);
      setBanner(null);
      const live = graph ?? storeApi.getState();
      // 快照本次提交对应的改动版本；请求在途期间的新编辑会让它前进
      const sentVersion = dirtyVersionRef.current;
      try {
        const res = await fetch(`/api/workflows/${workflowId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description,
            nodes: live.nodes.map(toNodeDto),
            edges: live.edges.map(toEdgeDto),
          }),
        });
        const body = (await res.json().catch(() => null)) as
          | (WorkflowDetail & { error?: string })
          | null;
        if (!res.ok) {
          setBanner(body?.error ?? "保存失败");
          return { ok: false, issues: [] };
        }
        const nextIssues = body?.issues ?? [];
        setIssues(nextIssues);
        // 设置页可能在另一个标签页里改了集合；PUT 响应带回服务端现值，检查器不拿旧集合收窄
        if (body?.workflow) {
          setSets({
            skillIds: body.workflow.skillIds ?? [],
            toolIds: body.workflow.toolIds ?? [],
          });
        }
        // 只有在途期间没有新改动才算「干净」，否则保留 dirty 等下一次保存
        if (dirtyVersionRef.current === sentVersion) setDirty(false);
        setSavedAt(new Date());
        return { ok: true, issues: nextIssues };
      } catch {
        setBanner("网络错误，保存失败");
        return { ok: false, issues: [] };
      } finally {
        setSaving(false);
      }
    },
    [storeApi, workflowId, name, description],
  );

  // ---------- Action 编辑回写（ADR-0004） ----------
  /**
   * 共享 Action 保存成功：把画布上引用它的**每一个**节点都刷新到最新端口。
   * 只改 nodes/edges，不碰视口 —— 用户的平移与缩放原样保留。
   */
  const applySavedAction = useCallback(
    (saved: ActionDto) => {
      setActions((prev) => prev.map((a) => (a.id === saved.id ? { ...a, ...saved } : a)));
      const live = storeApi.getState();
      const nextNodes = live.nodes.map((n) =>
        n.data.actionId === saved.id ? applyActionToNode(n, saved, modelById) : n,
      );
      const nextEdges = pruneEdges(nextNodes, live.edges);
      setNodes(nextNodes);
      const dropped = live.edges.length - nextEdges.length;
      if (dropped > 0) setEdges(nextEdges);
      // 走 markDirty 而不是裸 setDirty(true)：它要同时推进改动版本号，
      // 否则保存在途期间的这次刷新会被返回后的 setDirty(false) 抹掉
      markDirty();
      setToast(
        dropped > 0
          ? `已保存「${saved.name}」，端口变化让 ${dropped} 条连线失效并已移除，记得重新保存工作流`
          : `已保存「${saved.name}」，画布上引用它的节点都已刷新`,
      );
    },
    [storeApi, setNodes, setEdges, modelById, markDirty],
  );

  /** 复制为新 Action 并替换本节点：改指新实体后立刻保存整图 */
  const applyFork = useCallback(
    async (nodeId: string, created: ActionDto) => {
      setActions((prev) => [...prev, { ...created, folder: null, refCount: 1 }]);
      const live = storeApi.getState();
      const nextNodes = live.nodes.map((n) =>
        n.id === nodeId ? applyActionToNode(n, created, modelById) : n,
      );
      const nextEdges = pruneEdges(nextNodes, live.edges);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setInspector(null);
      const result = await persist({ nodes: nextNodes, edges: nextEdges });
      setToast(
        result.ok
          ? `已复制为新 Action「${created.name}」并替换本节点，原 Action 与其它工作流不受影响`
          : `已复制为「${created.name}」并替换本节点，但工作流保存失败，请手动保存`,
      );
    },
    [storeApi, setNodes, setEdges, modelById, persist],
  );

  // ---------- 运行 ----------

  const handleRun = useCallback(async () => {
    const result = await persist();
    if (!result.ok) return;
    if (result.issues.length > 0) {
      setBanner("存在校验问题，修复后才能运行");
      return;
    }
    const { nodes: liveNodes } = storeApi.getState();
    const specs: RunInputSpec[] = liveNodes
      .filter((n) => n.data.kind === "input")
      .map((n) => ({
        nodeId: n.id,
        label: n.data.label,
        typeName: n.data.outputs[0]?.objectTypeName ?? "未知类型",
        kind: n.data.outputs[0]?.kind ?? "text",
      }));
    setRunSpecs(specs);
  }, [persist, storeApi]);

  const startRun = useCallback(
    async (inputs: Record<string, PortValue>) => {
      setSubmittingRun(true);
      try {
        const res = await fetch(`/api/workflows/${workflowId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputs }),
        });
        const body = (await res.json().catch(() => null)) as {
          runId?: string;
          error?: string;
          issues?: ValidationIssue[];
        } | null;
        if (!res.ok || !body?.runId) {
          if (res.status === 422 && Array.isArray(body?.issues)) {
            setIssues(body.issues);
          }
          setBanner(body?.error ?? "运行失败");
          setRunSpecs(null);
          return;
        }
        setRunSpecs(null);
        setBanner(null);
        // 看运行只有运行页一个地方：受理成功即跳走，编辑器不跟随（ADR-0018）
        router.push(`/runs/${encodeURIComponent(body.runId)}`);
      } finally {
        setSubmittingRun(false);
      }
    },
    [workflowId, router],
  );

  // ---------- 键盘 ----------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void persist();
        return;
      }
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const selected = storeApi
          .getState()
          .nodes.filter((n) => n.selected)
          .map((n) => n.id);
        for (const id of selected) duplicateNode(id);
        return;
      }
      if (e.key === "Escape") {
        setMenu(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [persist, duplicateNode, storeApi]);

  const canvasState = useMemo(
    () => ({ connecting, issueNodeIds, onEditAction: openInspector }),
    [connecting, issueNodeIds, openInspector],
  );

  // ---------- 渲染 ----------
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">加载中…</div>
    );
  }
  if (loadError) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
        <Link
          href="/workflows"
          className="mt-4 inline-block text-sm text-zinc-500 underline hover:text-zinc-800"
        >
          返回工作流列表
        </Link>
      </div>
    );
  }

  const selectedNodeIds = nodes.filter((n) => n.selected).map((n) => n.id);
  const menuNode = menu?.nodeId ? nodes.find((n) => n.id === menu.nodeId) : undefined;
  const inspectorReady = models.length > 0;

  return (
    <div className="flex h-full">
      <NodePanel
        actions={actions}
        objectTypes={objectTypes}
        onAddAction={addActionNode}
        onAddIO={addIONode}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2.5">
          <Link
            href="/workflows"
            className="shrink-0 text-sm text-zinc-400 hover:text-zinc-700"
            title="返回工作流列表"
          >
            ← 列表
          </Link>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              markDirty();
            }}
            onBlur={() => {
              if (dirty) void persist();
            }}
            placeholder="工作流名称"
            title="点击直接改名，失焦自动保存"
            className="w-60 rounded-md border border-transparent px-2 py-1 text-sm font-semibold text-zinc-900 hover:border-zinc-200 focus:border-zinc-400 focus:outline-none"
          />

          <SaveState saving={saving} dirty={dirty} savedAt={savedAt} />

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Link
              href={`/workflows/${encodeURIComponent(workflowId)}/settings`}
              title="工作流级指令、插件开关、MCP 子集、技能集与 Tool 集"
              className="rounded-md px-2.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            >
              工作流设置
            </Link>
            <button
              type="button"
              onClick={() => void persist()}
              disabled={saving}
              className="rounded-md border border-zinc-300 bg-white px-3.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={saving}
              className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {/* 运行彼此独立，随时可以再开一路；发起后跳到那一路自己的运行页 */}
              运行
            </button>
          </div>
        </header>

        {banner && (
          <div className="flex items-start justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            <span>{banner}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="text-red-400 hover:text-red-700"
            >
              ×
            </button>
          </div>
        )}
        {issues.length > 0 && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2">
            <p className="text-xs font-medium text-amber-800">
              校验问题（{issues.length}）：点击任意一条定位到画布
            </p>
            <ul className="mt-1 space-y-0.5">
              {issues.map((issue, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => locateIssue(issue)}
                    className="w-full rounded px-1 py-0.5 text-left text-xs text-amber-800 underline decoration-amber-300 decoration-dotted underline-offset-2 hover:bg-amber-100 hover:decoration-amber-700"
                  >
                    {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div ref={wrapperRef} className="relative min-h-0 flex-1">
          <CanvasStateProvider value={canvasState}>
            <ReactFlow
              edgeTypes={edgeTypes}
              defaultEdgeOptions={defaultEdgeOptions}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onNodeDoubleClick={(_e, node) => openInspector(node.id)}
              onNodeDrag={(_e, node) => updateGuides(node)}
              onNodeDragStop={() => setGuides({ v: [], h: [] })}
              onNodeContextMenu={(e, node) => {
                e.preventDefault();
                const rect = wrapperRef.current?.getBoundingClientRect();
                setMenu({
                  x: e.clientX - (rect?.left ?? 0),
                  y: e.clientY - (rect?.top ?? 0),
                  nodeId: node.id,
                });
              }}
              onPaneContextMenu={(e) => {
                e.preventDefault();
                const rect = wrapperRef.current?.getBoundingClientRect();
                const mouse = e as MouseEvent;
                setMenu({
                  x: mouse.clientX - (rect?.left ?? 0),
                  y: mouse.clientY - (rect?.top ?? 0),
                  nodeId: null,
                });
              }}
              onPaneClick={() => setMenu(null)}
              onMoveStart={() => setMenu(null)}
              deleteKeyCode={["Backspace", "Delete"]}
              multiSelectionKeyCode={MULTI_SELECT_KEYS}
              selectionOnDrag={boxSelect}
              panOnDrag={boxSelect ? [1] : undefined}
              snapToGrid={snap}
              snapGrid={[16, 16]}
              minZoom={0.2}
              maxZoom={2}
              fitView
              className="bg-zinc-100"
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeStrokeWidth={2}
                nodeColor={(n) => MINIMAP_COLOR[(n as FlowNode).data.kind] ?? "#a1a1aa"}
                maskColor="rgba(244,244,245,0.7)"
              />

              {/* 画布小工具条 */}
              <Panel
                position="top-right"
                className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white/90 p-1 text-xs shadow-sm backdrop-blur"
              >
                <ToolButton
                  active={boxSelect}
                  title="框选模式：左键拖出选框（关闭时按住 Shift 拖也能框选）"
                  onClick={() => setBoxSelect((v) => !v)}
                >
                  框选
                </ToolButton>
                <ToolButton
                  active={snap}
                  title="拖动时吸附到 16px 网格"
                  onClick={() => setSnap((v) => !v)}
                >
                  网格吸附
                </ToolButton>
                <ToolButton
                  active={false}
                  title="缩放到适应全部节点"
                  onClick={() => void fitView({ duration: 300, padding: 0.2 })}
                >
                  适应视图
                </ToolButton>
              </Panel>

              {/* 对齐辅助线：只做视觉参考，真正的吸附交给「网格吸附」 */}
              <ViewportPortal>
                {guides.v.map((x) => (
                  <div
                    key={`v${x}`}
                    style={{
                      position: "absolute",
                      left: x,
                      top: -50000,
                      width: 1,
                      height: 100000,
                      background: "#f43f5e",
                      pointerEvents: "none",
                    }}
                  />
                ))}
                {guides.h.map((y) => (
                  <div
                    key={`h${y}`}
                    style={{
                      position: "absolute",
                      top: y,
                      left: -50000,
                      height: 1,
                      width: 100000,
                      background: "#f43f5e",
                      pointerEvents: "none",
                    }}
                  />
                ))}
              </ViewportPortal>
            </ReactFlow>
          </CanvasStateProvider>

          {/* 空画布引导 */}
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="ff-rise-in max-w-md rounded-xl border border-dashed border-zinc-300 bg-white/80 px-6 py-5 text-center backdrop-blur">
                <p className="text-sm font-medium text-zinc-700">画布还是空的</p>
                <ol className="mt-2 space-y-1 text-xs leading-5 text-zinc-500">
                  <li>1. 从左侧面板拖一个「输入节点」进来，选好对象类型</li>
                  <li>2. 拖入需要的 Action，把同类型的端口连起来</li>
                  <li>3. 末端接一个「输出节点」，点右上角「运行」</li>
                </ol>
                <p className="mt-3 text-[11px] text-zinc-400">
                  双击 Action 节点可以直接编辑它引用的 Action（改的是共享实体）
                </p>
              </div>
            </div>
          )}

          {/* 右键菜单 */}
          {menu && (
            <div
              className="ff-rise-in absolute z-40 min-w-44 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg"
              style={{ left: menu.x, top: menu.y }}
              onMouseLeave={() => setMenu(null)}
            >
              {menuNode ? (
                <>
                  <p className="truncate px-3 py-1 text-[11px] text-zinc-400">
                    {menuNode.data.label}
                  </p>
                  {menuNode.data.kind === "action" && (
                    <MenuItem onClick={() => openInspector(menuNode.id)}>编辑 Action…</MenuItem>
                  )}
                  <MenuItem
                    onClick={() => {
                      duplicateNode(menuNode.id);
                      setMenu(null);
                    }}
                  >
                    复制节点
                    <span className="ml-auto text-[11px] text-zinc-300">⌘D</span>
                  </MenuItem>
                  <MenuItem
                    danger
                    onClick={() => {
                      removeNodes(
                        selectedNodeIds.includes(menuNode.id) ? selectedNodeIds : [menuNode.id],
                      );
                      setMenu(null);
                    }}
                  >
                    {selectedNodeIds.length > 1 && selectedNodeIds.includes(menuNode.id)
                      ? `删除选中的 ${selectedNodeIds.length} 个节点`
                      : "删除节点"}
                    <span className="ml-auto text-[11px] text-zinc-300">Del</span>
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuItem
                    onClick={() => {
                      setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
                      setMenu(null);
                    }}
                  >
                    全选节点
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void fitView({ duration: 300, padding: 0.2 });
                      setMenu(null);
                    }}
                  >
                    适应视图
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      setBoxSelect((v) => !v);
                      setMenu(null);
                    }}
                  >
                    {boxSelect ? "关闭框选模式" : "开启框选模式"}
                  </MenuItem>
                </>
              )}
            </div>
          )}

          {/* 轻提示 */}
          {toast && (
            <div className="ff-rise-in absolute bottom-4 left-1/2 z-40 max-w-lg -translate-x-1/2 rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs text-white shadow-lg">
              {toast}
              <button
                type="button"
                onClick={() => setToast(null)}
                className="ml-3 text-zinc-400 hover:text-white"
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>

      {runSpecs && (
        <RunDialog
          specs={runSpecs}
          submitting={submittingRun}
          onCancel={() => setRunSpecs(null)}
          onSubmit={(inputs) => void startRun(inputs)}
        />
      )}

      {inspector && inspectorReady && (
        <ActionInspector
          target={inspector}
          workflowId={workflowId}
          sets={sets}
          models={models}
          objectTypes={objectTypes}
          skills={skills}
          tools={tools}
          onClose={() => setInspector(null)}
          onSaved={applySavedAction}
          onForked={applyFork}
        />
      )}
      {inspector && !inspectorReady && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="max-w-sm rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-700 shadow-xl">
            模型清单加载失败，暂时无法在画布上编辑 Action。
            <div className="mt-4 text-right">
              <button
                type="button"
                onClick={() => setInspector(null)}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SaveState({
  saving,
  dirty,
  savedAt,
}: {
  saving: boolean;
  dirty: boolean;
  savedAt: Date | null;
}) {
  const text = saving
    ? "保存中…"
    : dirty
      ? "有未保存的改动"
      : savedAt
        ? `已保存 ${savedAt.toLocaleTimeString("zh-CN", { hour12: false })}`
        : "已同步";
  const tone = saving ? "text-zinc-400" : dirty ? "text-amber-600" : "text-zinc-400";
  return (
    <span className={`flex shrink-0 items-center gap-1.5 text-xs ${tone}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          saving ? "bg-zinc-300" : dirty ? "bg-amber-500" : "bg-emerald-500"
        }`}
      />
      {text}
    </span>
  );
}

function ToolButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-md px-2 py-1 transition-colors ${
        active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
        danger ? "text-red-600 hover:bg-red-50" : "text-zinc-700 hover:bg-zinc-100"
      }`}
    >
      {children}
    </button>
  );
}
