import type { DataContext, GraphSpec, UploadedDataset } from "@causal-workbench/shared";

export interface ProjectSnapshot {
  version: string;
  savedAt: string;
  graph: GraphSpec;
  dataContext: DataContext;
  uploadedDataset: UploadedDataset | null;
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
    isUploadedDataset(candidate.uploadedDataset)
  );
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
