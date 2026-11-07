import type { DataContext, GraphSpec, GraphVersion, UncertainPair, UploadedDataset } from "@causal-graph-workbench/shared";

export interface ProjectSnapshot {
  version: string;
  savedAt: string;
  graph: GraphSpec;
  dataContext: DataContext;
  uploadedDataset: UploadedDataset | null;
  /** Every graph being compared, when there is more than one. Projects saved before this have only `graph`. */
  versions?: GraphVersion[];
  activeVersionId?: string;
  /** Arrows marked as not settled. */
  uncertainPairs?: UncertainPair[];
}

export function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ProjectSnapshot>;
  return (
    typeof candidate.version === "string" &&
    typeof candidate.savedAt === "string" &&
    isGraphSpec(candidate.graph) &&
    isDataContext(candidate.dataContext) &&
    isUploadedDataset(candidate.uploadedDataset) &&
    (candidate.versions === undefined || (Array.isArray(candidate.versions) && candidate.versions.every(isGraphVersion))) &&
    (candidate.uncertainPairs === undefined || (Array.isArray(candidate.uncertainPairs) && candidate.uncertainPairs.every(isUncertainPair)))
  );
}

function isUncertainPair(value: unknown): value is UncertainPair {
  const candidate = value as Partial<UncertainPair> | null;
  return typeof candidate?.first === "string" && typeof candidate?.second === "string";
}

function isGraphVersion(value: unknown): value is GraphVersion {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GraphVersion>;
  return typeof candidate.id === "string" && typeof candidate.name === "string" && isGraphSpec(candidate.graph);
}

function isGraphSpec(value: unknown): value is GraphSpec {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GraphSpec>;
  return (
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges) &&
    ("treatmentId" in candidate) &&
    ("outcomeId" in candidate)
  );
}

function isDataContext(value: unknown): value is DataContext {
  return Boolean(value && typeof value === "object");
}

function isUploadedDataset(value: unknown): value is UploadedDataset | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<UploadedDataset>;
  return typeof candidate.content === "string";
}
