import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";

import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { DataStep } from "./DataStep";
import { GraphStep } from "./GraphStep";
import { ResultStep } from "./ResultStep";
import { TourCard } from "./TourCard";

/** The one thing to do now. The canvas stays beside it throughout. */
export function StepPanel({ analysis, graph }: { analysis: AnalysisResult | null; graph: GraphSpec }) {
  const step = useWorkbenchStore((state) => state.step);
  return (
    <aside className="panel">
      {step === "graph" ? <GraphStep analysis={analysis} /> : null}
      {step === "data" ? <DataStep analysis={analysis} /> : null}
      {step === "result" ? <ResultStep analysis={analysis} graph={graph} /> : null}
      <TourCard />
    </aside>
  );
}
