import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useMemo, type RefObject } from "react";

import { useWorkbenchStore } from "../store/useWorkbenchStore";

interface GraphCanvasProps {
  graph: GraphSpec;
  analysis: AnalysisResult | null;
  graphShellRef: RefObject<HTMLDivElement>;
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvasInner({ graph, analysis, graphShellRef }: GraphCanvasProps) {
  const connectNodes = useWorkbenchStore((state) => state.connectNodes);
  const updateNodePosition = useWorkbenchStore((state) => state.updateNodePosition);
  const removeNode = useWorkbenchStore((state) => state.removeNode);
  const removeEdge = useWorkbenchStore((state) => state.removeEdge);
  const selectedExplainable = useWorkbenchStore((state) => state.selectedExplainable);
  const highlightedPathId = useWorkbenchStore((state) => state.highlightedPathId);
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const setHighlightedPathId = useWorkbenchStore((state) => state.setHighlightedPathId);

  const highlightedPath = analysis?.paths.find((path) => path.id === highlightedPathId) ?? null;
  const highlightedNodes = new Set(highlightedPath?.nodes ?? []);
  const highlightedEdges = new Set<string>();
  if (highlightedPath) {
    for (let index = 0; index < highlightedPath.nodes.length - 1; index += 1) {
      const left = highlightedPath.nodes[index];
      const right = highlightedPath.nodes[index + 1];
      highlightedEdges.add(`${left}->${right}`);
      highlightedEdges.add(`${right}->${left}`);
    }
  }

  const roleLookup = new Map(analysis?.nodeRoles.map((item) => [item.nodeId, item.roles]) ?? []);

  const nodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        data: { label: node.label },
        position: { x: node.x, y: node.y },
        style: nodeStyle(node.id, graph, roleLookup.get(node.id) ?? [], selectedExplainable, highlightedNodes),
      })),
    [graph, highlightedNodes, roleLookup, selectedExplainable],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: highlightedEdges.has(edge.id),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
          color: highlightedEdges.has(edge.id) ? "#d86f42" : "#8f6f3c",
        },
        style: {
          stroke: highlightedEdges.has(edge.id) ? "#d86f42" : "#8f6f3c",
          strokeWidth: highlightedEdges.has(edge.id) ? 3 : 2,
        },
      })),
    [graph.edges, highlightedEdges],
  );

  const defaultViewport = { x: 0, y: 0, zoom: 0.9 };

  return (
    <div className="graph-shell" ref={graphShellRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        defaultViewport={defaultViewport}
        onConnect={(connection: Connection) => {
          if (connection.source && connection.target) {
            connectNodes(connection.source, connection.target);
          }
        }}
        onPaneClick={() => {
          setSelectedExplainable(null);
          setHighlightedPathId(null);
        }}
        onNodeClick={(_, node) => setSelectedExplainable({ kind: "node", id: node.id })}
        onNodeDragStop={(_, node) => updateNodePosition(node.id, node.position.x, node.position.y)}
        onNodesDelete={(deleted) => deleted.forEach((node) => removeNode(node.id))}
        onEdgesDelete={(deleted) => deleted.forEach((edge) => removeEdge(edge.id))}
        deleteKeyCode={["Backspace", "Delete"]}
        className="graph-canvas"
        fitViewOptions={{ padding: 0.24, duration: 360 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} color="#dfd4bf" />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function nodeStyle(
  nodeId: string,
  graph: GraphSpec,
  roles: string[],
  selectedExplainable: { kind: string; id: string } | null,
  highlightedNodes: Set<string>,
) {
  const isTreatment = graph.treatmentId === nodeId;
  const isOutcome = graph.outcomeId === nodeId;
  const isSelected = selectedExplainable?.kind === "node" && selectedExplainable.id === nodeId;
  const isHighlighted = highlightedNodes.has(nodeId);
  const isForbidden = roles.includes("mediator") || roles.includes("descendant_of_treatment");

  let background = "#fffaf0";
  let color = "#2e2515";
  if (isTreatment) {
    background = "#d86f42";
    color = "#fffdf7";
  } else if (isOutcome) {
    background = "#1d6a57";
    color = "#fffdf7";
  } else if (roles.includes("confounder")) {
    background = "#f4d49c";
  } else if (roles.includes("collider")) {
    background = "#d8e5f3";
  } else if (isForbidden) {
    background = "#efd2cb";
  }

  return {
    borderRadius: 18,
    border: `2px solid ${isHighlighted ? "#d86f42" : isSelected ? "#1d6a57" : "#8f6f3c"}`,
    background,
    color,
    padding: 12,
    minWidth: 96,
    fontWeight: 700,
    boxShadow: isHighlighted ? "0 0 0 6px rgba(216, 111, 66, 0.16)" : "0 10px 26px rgba(65, 45, 15, 0.10)",
  };
}
