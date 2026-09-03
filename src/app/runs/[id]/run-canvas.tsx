"use client";

/**
 * 运行页的只读画布：节点与连线来自受理时冻结的 `runs.graph`（ADR-0018），
 * 视觉来自 visualsAt(t)，经 CanvasVisualsProvider 下发给共用的 FlowNodeView / FlowEdgeView。
 *
 * 只读的含义：不可拖动、不可连线、可点选（点节点开抽屉），初始 fitView。
 * 空图就是空画布——早于 ADR-0018 的运行走的是同一条渲染路径，这里不写「旧运行」分支。
 */
import { useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FlowEdgeView } from "@/components/canvas/flow-edge";
import { FlowNodeView } from "@/components/canvas/flow-node";
import type { FlowNode, PortSnapshot } from "@/components/canvas/node-model";
import { CanvasVisualsProvider, type CanvasVisuals } from "@/components/canvas/node-visuals";
import type { ResolvedPort } from "@/lib/graph";
import type { RunGraph } from "@/lib/run-graph";

// 模块级常量：放进组件体会每帧新建对象，导致 React Flow 反复重建节点与边
const nodeTypes = { flowNode: FlowNodeView };
const edgeTypes = { flowEdge: FlowEdgeView };

const MINIMAP_COLOR: Record<string, string> = {
  action: "#a1a1aa",
  input: "#7dd3fc",
  output: "#6ee7b7",
};

function toPortSnapshot(port: ResolvedPort): PortSnapshot {
  return {
    name: port.name,
    objectTypeId: port.objectTypeId,
    objectTypeName: port.objectTypeName,
    kind: port.kind,
    exitName: port.exitName ?? null,
  };
}

function toFlowNodes(graph: RunGraph): FlowNode[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: "flowNode" as const,
    position: { x: node.x, y: node.y },
    data: {
      kind: node.kind,
      actionId: node.actionId,
      objectTypeId: node.objectTypeId,
      label: node.label,
      inputs: node.inputs.map(toPortSnapshot),
      outputs: node.outputs.map(toPortSnapshot),
    },
  }));
}

function toFlowEdges(graph: RunGraph): Edge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: edge.sourcePort,
    target: edge.targetNodeId,
    targetHandle: edge.targetPort,
    type: "flowEdge" as const,
  }));
}

export function RunCanvas({
  graph,
  visuals,
  onSelectNode,
  onClearSelection,
}: {
  graph: RunGraph;
  visuals: CanvasVisuals;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(toFlowNodes(graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(graph));

  // 图是冻结件，同一条运行里不会变；identity 变化只发生在换运行或首帧到达时
  useEffect(() => {
    setNodes(toFlowNodes(graph));
    setEdges(toFlowEdges(graph));
  }, [graph, setNodes, setEdges]);

  return (
    <CanvasVisualsProvider value={visuals}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        onPaneClick={onClearSelection}
        deleteKeyCode={null}
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
      </ReactFlow>
    </CanvasVisualsProvider>
  );
}
