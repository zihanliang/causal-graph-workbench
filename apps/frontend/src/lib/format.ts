import type { EffectEstimate, LoadBearingAssumption } from "@causal-graph-workbench/shared";

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const size = Math.abs(value);
  // Very large numbers would run to hundreds of digits, and small ones would read as exactly zero.
  if (size >= 1e7) {
    return value.toExponential(2);
  }
  if (size > 0 && size < 0.001) {
    return value.toPrecision(3);
  }
  if (size >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (size >= 100) {
    return value.toFixed(1);
  }
  if (size >= 10) {
    return value.toFixed(2);
  }
  return value.toFixed(3);
}

export function formatSet(values: string[]): string {
  return values.length ? `{${values.join(", ")}}` : "{}";
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: string[]): string {
  if (names.length < 2) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** At most a few names, so that a long list cannot push everything else off the screen. */
export function shortList(names: string[], limit = 5): string {
  if (names.length <= limit) {
    return joinNames(names);
  }
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} others`;
}

/** The word printed under a variable on the canvas, so the graph can be read without a legend. */
export function roleCaption(
  nodeId: string,
  isMeasured: boolean,
  graph: { treatmentId: string | null; outcomeId: string | null },
  roles: readonly string[],
): string | null {
  if (graph.treatmentId === nodeId) {
    return "treatment";
  }
  if (graph.outcomeId === nodeId) {
    return "outcome";
  }
  if (!isMeasured) {
    return "not measured";
  }
  if (roles.includes("confounder")) {
    return roles.includes("collider") ? "confounder, collider" : "confounder";
  }
  if (roles.includes("mediator")) {
    return "mediator";
  }
  if (roles.includes("instrument_like")) {
    return "instrument-like";
  }
  if (roles.includes("collider")) {
    return "collider";
  }
  if (roles.includes("descendant_of_treatment")) {
    return "after treatment";
  }
  return null;
}

function toDisplay(estimate: EffectEstimate, value: number): number {
  return estimate.scale === "log_odds_ratio" ? Math.exp(value) : value;
}

/** A log odds ratio is computed on the log scale but read as an odds ratio. */
export function effectValue(estimate: EffectEstimate): string {
  return formatNumber(toDisplay(estimate, estimate.estimate));
}

export function effectInterval(estimate: EffectEstimate): string {
  return `${formatNumber(toDisplay(estimate, estimate.ciLow))} to ${formatNumber(toDisplay(estimate, estimate.ciHigh))}`;
}

export function effectSummary(estimate: EffectEstimate): string {
  return `${effectValue(estimate)} (95% CI ${effectInterval(estimate)})`;
}

/** How far the estimate would move, on the scale people read it on. */
export function shiftSummary(assumption: LoadBearingAssumption): string | null {
  const { alternativeEstimate, baselineOnSameRows } = assumption;
  if (!alternativeEstimate || baselineOnSameRows === null) {
    return null;
  }
  const before = formatNumber(toDisplay(alternativeEstimate, baselineOnSameRows));
  return `The estimate would go from ${before} to ${effectSummary(alternativeEstimate)}.`;
}

export function repairSummary(assumption: LoadBearingAssumption): string {
  if (!assumption.repair) {
    return "No measured set of variables would be valid if this were true.";
  }
  const parts: string[] = [];
  if (assumption.addedToSet.length) {
    parts.push(`also adjust for ${assumption.addedToSet.join(", ")}`);
  }
  if (assumption.removedFromSet.length) {
    parts.push(`stop adjusting for ${assumption.removedFromSet.join(", ")}`);
  }
  return `To stay valid you would need to ${parts.join(" and ")}.`;
}

export function arrowLabel(assumption: Pick<LoadBearingAssumption, "edit" | "source" | "target">): string {
  const { edit, source, target } = assumption;
  return edit === "add" ? `${source} → ${target}` : edit === "reverse" ? `${target} → ${source}` : `no ${source} → ${target}`;
}
