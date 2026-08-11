"use client";

/**
 * 画布编辑器主体：@xyflow/react v12。
 * - 单一自定义 nodeType（flow-node.tsx 内部按 data.kind 分发）
 * - isValidConnection 用 store.getState() 取最新图（防 stale 闭包）：
 *   同 objectTypeId + 目标输入端口无入线 + getOutgoers DFS 防环
 * - 保存 = PUT 整图（toNodeDto/toEdgeDto 白名单序列化，剥 `_` 瞬态字段）
 * - 运行 = 自动保存 → 收集输入 → POST run → SSE 订阅把节点状态写回 data._status
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getOutgoers,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type IsValidConnection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ValidationIssue } from "@/lib/graph";
import type { PortValue } from "@/lib/values";
import { FlowNodeView } from "./flow-node";
import { ACTION_DRAG_MIME, NodePanel } from "./node-panel";
import { RunDialog, type RunInputSpec } from "./run-dialog";
import {
  actionPortSnapshots,
  buildFlowEdges,
  buildFlowNodes,
  toEdgeDto,
  toNodeDto,
  type ActionDto,
  type FlowNode,
  type ObjectTypeRow,
  type RunNodeStatus,
  type WorkflowDetail,
} from "./types";

const nodeTypes = { flowNode: FlowNodeView };

const RUN_STATUS_TEXT: Record<string, string> = {
  running: "运行中…",
  success: "运行成功",
  failed: "运行失败",
};

const RUN_STATUS_CLASS: Record<string, string> = {
  running: "bg-blue-50 text-blue-700 border-blue-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

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
  const [actions, setActions] = useState<ActionDto[]>([]);
  const [objectTypes, setObjectTypes] = useState<ObjectTypeRow[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runSpecs, setRunSpecs] = useState<RunInputSpec[] | null>(null);
  const [submittingRun, setSubmittingRun] = useState(false);
  const [runInfo, setRunInfo] = useState<{
    runId: string;
    status: string;
  } | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const storeApi = useStoreApi<FlowNode, Edge>();
  const { screenToFlowPosition } = useReactFlow<FlowNode, Edge>();

  // ---------- 加载 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [wfRes, actRes, typeRes] = await Promise.all([
          fetch(`/api/workflows/${workflowId}`),
          fetch("/api/actions"),
          fetch("/api/object-types"),
        ]);
        const readError = async (res: Response, fallback: string) => {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          return body?.error ?? fallback;
        };
        if (!wfRes.ok) throw new Error(await readError(wfRes, "加载工作流失败"));
        if (!actRes.ok)
          throw new Error(await readError(actRes, "加载 Action 列表失败"));
        if (!typeRes.ok)
          throw new Error(await readError(typeRes, "加载对象类型失败"));
        const wf = (await wfRes.json()) as WorkflowDetail;
        const acts = (await actRes.json()) as ActionDto[];
        const types = (await typeRes.json()) as ObjectTypeRow[];
        if (cancelled) return;
        setActions(acts);
        setObjectTypes(types);
        setName(wf.workflow.name);
        setDescription(wf.workflow.description ?? "");
        setIssues(wf.issues ?? []);
        const flowNodes = buildFlowNodes(
          wf.nodes ?? [],
          new Map(acts.map((a) => [a.id, a])),
          new Map(types.map((t) => [t.id, t])),
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

  // 卸载时关闭 SSE
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  // ---------- 连线 ----------
  const isValidConnection: IsValidConnection<Edge> = useCallback(
    (conn) => {
      // 用 store 最新状态，绝不依赖渲染期闭包（Dify 模式）
      const { nodes: liveNodes, edges: liveEdges } = storeApi.getState();
      const source = liveNodes.find((n) => n.id === conn.source);
      const target = liveNodes.find((n) => n.id === conn.target);
      if (!source || !target || source.id === target.id) return false;

      const sourcePort = source.data.outputs.find(
        (p) => p.name === (conn.sourceHandle ?? "value"),
      );
      const targetPort = target.data.inputs.find(
        (p) => p.name === (conn.targetHandle ?? "value"),
      );
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
    },
    [setEdges],
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
    (action: ActionDto, position?: { x: number; y: number }) => {
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
        },
      };
      setNodes((nds) => [...nds, node]);
    },
    [canvasCenter, setNodes],
  );

  const addIONode = useCallback(
    (kind: "input" | "output", type: ObjectTypeRow) => {
      const port = {
        name: "value",
        objectTypeId: type.id,
        objectTypeName: type.name,
        kind: type.kind,
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
    },
    [canvasCenter, setNodes],
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
      const action = actions.find((a) => a.id === actionId);
      if (!action) return;
      addActionNode(
        action,
        screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      );
    },
    [actions, addActionNode, screenToFlowPosition],
  );

  // ---------- 保存 ----------
  const save = useCallback(async (): Promise<{
    ok: boolean;
    issues: ValidationIssue[];
  }> => {
    setSaving(true);
    setBanner(null);
    try {
      const { nodes: liveNodes, edges: liveEdges } = storeApi.getState();
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          nodes: liveNodes.map(toNodeDto),
          edges: liveEdges.map(toEdgeDto),
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
      return { ok: true, issues: nextIssues };
    } catch {
      setBanner("网络错误，保存失败");
      return { ok: false, issues: [] };
    } finally {
      setSaving(false);
    }
  }, [storeApi, workflowId, name, description]);

  // ---------- 运行 ----------
  const subscribe = useCallback(
    (runId: string) => {
      esRef.current?.close();
      setRunInfo({ runId, status: "running" });
      const es = new EventSource(`/api/runs/${runId}/events`);
      es.addEventListener("snapshot", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as {
            run?: { status?: string };
            nodes?: Array<{ nodeId: string; status: RunNodeStatus }>;
          };
          if (data.run?.status) {
            setRunInfo({ runId, status: data.run.status });
          }
          const statusByNode = new Map(
            (data.nodes ?? []).map(
              (n): [string, RunNodeStatus] => [n.nodeId, n.status],
            ),
          );
          setNodes((nds) =>
            nds.map((n) => {
              const status = statusByNode.get(n.id);
              if (status === n.data._status) return n;
              return { ...n, data: { ...n.data, _status: status } };
            }),
          );
        } catch {
          // 忽略坏帧
        }
      });
      es.addEventListener("end", () => {
        es.close();
      });
      esRef.current = es;
    },
    [setNodes],
  );

  const handleRun = useCallback(async () => {
    const result = await save();
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
  }, [save, storeApi]);

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
        subscribe(body.runId);
      } finally {
        setSubmittingRun(false);
      }
    },
    [workflowId, subscribe],
  );

  // ---------- 渲染 ----------
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">
        加载中…
      </div>
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
          >
            ← 列表
          </Link>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="工作流名称"
            className="w-56 rounded-md border border-transparent px-2 py-1 text-sm font-semibold text-zinc-900 hover:border-zinc-200 focus:border-zinc-400 focus:outline-none"
          />
          {runInfo && (
            <span className="flex shrink-0 items-center gap-2">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  RUN_STATUS_CLASS[runInfo.status] ??
                  "border-zinc-200 bg-zinc-50 text-zinc-600"
                }`}
              >
                {RUN_STATUS_TEXT[runInfo.status] ?? runInfo.status}
              </span>
              <Link
                href={`/runs/${runInfo.runId}`}
                className="text-xs text-zinc-500 underline hover:text-zinc-800"
              >
                查看运行详情
              </Link>
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md border border-zinc-300 bg-white px-3.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={saving || runInfo?.status === "running"}
              className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
            >
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
              校验问题（{issues.length}）：
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">
              {issues.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}

        <div ref={wrapperRef} className="min-h-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onDrop={onDrop}
            onDragOver={onDragOver}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            className="bg-zinc-100"
          >
            <Background gap={16} />
            <Controls />
          </ReactFlow>
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
    </div>
  );
}
