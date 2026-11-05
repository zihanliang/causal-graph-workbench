import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";
import {
  Background,
  BaseEdge,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getStraightPath,
  useInternalNode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useEffect, useMemo, type RefObject } from "react";

import { roleCaption } from "../lib/format";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

interface GraphCanvasProps {
  graph: GraphSpec;
  analysis: AnalysisResult | null;
  graphShellRef: RefObject<HTMLDivElement>;
}

const PREVIEW_EDGE_ID = "__assumption-preview";
const ARROW_GAP = 3;
const FIT_VIEW = { padding: 0.12, duration: 240, maxZoom: 1.1 };
const COLORS = {
  ink: "#131416",
  arrow: "#8a8f94",
  causal: "#c2552b",
  whatIf: "#2f70bb",
  focus: "#131416",
};

/** Where a straight line towards `other` leaves the box of `node`, with a little air for the arrowhead. */
function borderPoint(node: InternalNode, other: InternalNode): [number, number] {
  const halfWidth = (node.measured.width ?? 0) / 2;
  const halfHeight = (node.measured.height ?? 0) / 2;
  const x = node.internals.positionAbsolute.x + halfWidth;
  const y = node.internals.positionAbsolute.y + halfHeight;
  const dx = other.internals.positionAbsolute.x + (other.measured.width ?? 0) / 2 - x;
  const dy = other.internals.positionAbsolute.y + (other.measured.height ?? 0) / 2 - y;
  if (!dx && !dy) {
    return [x, y];
  }
  const scale = Math.min(dx ? (halfWidth + ARROW_GAP) / Math.abs(dx) : Infinity, dy ? (halfHeight + ARROW_GAP) / Math.abs(dy) : Infinity);
  return [x + dx * scale, y + dy * scale];
}

/** Arrows run straight from box to box, as causal graphs are drawn, so they read the same in any direction. */
function CausalArrow({ id, source, target, markerEnd, style }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) {
    return null;
  }
  const [sourceX, sourceY] = borderPoint(sourceNode, targetNode);
  const [targetX, targetY] = borderPoint(targetNode, sourceNode);
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}

const EDGE_TYPES = { causal: CausalArrow };

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
  const previewArrow = useWorkbenchStore((state) => state.previewArrow);
  const layoutVersion = useWorkbenchStore((state) => state.layoutVersion);
  const isDrawing = useWorkbenchStore((state) => state.step === "graph");
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const setHighlightedPathId = useWorkbenchStore((state) => state.setHighlightedPathId);
  const { fitView } = useReactFlow();

  // `fitView` on the component only applies on mount, so a pasted graph could land out of view.
  const nodeSetKey = graph.nodes.map((node) => node.id).sort().join("|");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitView(FIT_VIEW);
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, nodeSetKey, layoutVersion]);

  // Turning a tablet or resizing the window should not leave the graph stranded in a corner.
  useEffect(() => {
    const shell = graphShellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") {
      return;
    }
    let timer = 0;
    let isFirst = true;
    const observer = new ResizeObserver(() => {
      if (isFirst) {
        isFirst = false;
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fitView(FIT_VIEW), 150);
    });
    observer.observe(shell);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [fitView, graphShellRef]);

  const highlightedPath = analysis?.paths.find((path) => path.id === highlightedPathId) ?? null;
  const highlightedNodes = new Set(highlightedPath?.nodes ?? []);
  const highlightedEdges = new Set<string>();
  if (highlightedPath) {
    highlightedPath.nodes.slice(0, -1).forEach((left, index) => {
      const right = highlightedPath.nodes[index + 1];
      highlightedEdges.add(`${left}->${right}`);
      highlightedEdges.add(`${right}->${left}`);
    });
  }

  // The arrows that carry the effect are the one coloured thing on the graph, as in the logo.
  const causalEdges = useMemo(() => {
    const edges = new Set<string>();
    for (const path of analysis?.paths ?? []) {
      if (path.category === "directed_causal") {
        path.nodes.slice(0, -1).forEach((source, index) => edges.add(`${source}->${path.nodes[index + 1]}`));
      }
    }
    return edges;
  }, [analysis?.paths]);

  const roleLookup = new Map(analysis?.nodeRoles.map((item) => [item.nodeId, item.roles]) ?? []);

  const nodes: Node[] = graph.nodes.map((node) => {
    const roles = roleLookup.get(node.id) ?? [];
    const isMeasured = node.observed !== false;
    const caption = roleCaption(node.id, isMeasured, graph, roles);
    return {
      id: node.id,
      type: "default",
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <>
            <span className="node__name">{node.label}</span>
            {caption ? <span className="node__role">{caption}</span> : null}
          </>
        ),
      },
      position: { x: node.x, y: node.y },
      className: nodeClass(node.id, isMeasured, graph, roles, selectedExplainable, highlightedNodes.has(node.id)),
    };
  });

  const edges: Edge[] = graph.edges.map((edge) => {
    const goesAway = previewArrow && previewArrow.edit !== "add" && previewArrow.source === edge.source && previewArrow.target === edge.target;
    const isHighlighted = highlightedEdges.has(edge.id);
    const isCausal = causalEdges.has(edge.id);
    const color = goesAway ? COLORS.whatIf : isHighlighted ? COLORS.focus : isCausal ? COLORS.causal : COLORS.arrow;
    return {
      id: edge.id,
      type: "causal",
      source: edge.source,
      target: edge.target,
      animated: isHighlighted,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
      style: {
        stroke: color,
        strokeWidth: isHighlighted || goesAway ? 2.5 : isCausal ? 2.25 : 1.5,
        ...(goesAway ? { strokeDasharray: "3 5" } : {}),
      },
    };
  });

  if (previewArrow && previewArrow.edit !== "remove") {
    edges.push({
      id: PREVIEW_EDGE_ID,
      type: "causal",
      source: previewArrow.edit === "add" ? previewArrow.source : previewArrow.target,
      target: previewArrow.edit === "add" ? previewArrow.target : previewArrow.source,
      animated: true,
      selectable: false,
      deletable: false,
      focusable: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: COLORS.whatIf },
      style: { stroke: COLORS.whatIf, strokeWidth: 2.5, strokeDasharray: "7 5" },
    });
  }

  return (
    <div className="graph-shell" ref={graphShellRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        edgeTypes={EDGE_TYPES}
        fitView
        defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
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
        className={isDrawing ? "graph-canvas graph-canvas--drawing" : "graph-canvas"}
        fitViewOptions={FIT_VIEW}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="#dfe2e5" />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function nodeClass(
  nodeId: string,
  isMeasured: boolean,
  graph: GraphSpec,
  roles: string[],
  selectedExplainable: { kind: string; id: string } | null,
  isHighlighted: boolean,
): string {
  const classes = ["node"];
  if (graph.treatmentId === nodeId || graph.outcomeId === nodeId) {
    classes.push("node--endpoint");
  } else if (!isMeasured) {
    classes.push("node--unmeasured");
  } else if (roles.includes("confounder")) {
    classes.push("node--confounder");
  } else if (roles.includes("mediator") || roles.includes("descendant_of_treatment")) {
    classes.push("node--downstream");
  } else if (roles.includes("collider")) {
    classes.push("node--collider");
  }
  if (selectedExplainable?.kind === "node" && selectedExplainable.id === nodeId) {
    classes.push("node--selected");
  }
  if (isHighlighted) {
    classes.push("node--highlighted");
  }
  return classes.join(" ");
}
