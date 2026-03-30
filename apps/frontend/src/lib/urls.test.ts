import { describe, expect, test } from "vitest";

import { joinApiBase, joinBasePath } from "./urls";

describe("deployment URL helpers", () => {
  test("joins a GitHub Pages base path to public assets", () => {
    expect(joinBasePath("/causal-graph-workbench/", "demo-data/simple-confounding-study.csv")).toBe(
      "/causal-graph-workbench/demo-data/simple-confounding-study.csv",
    );
  });

  test("normalizes a base path without leading or trailing slashes", () => {
    expect(joinBasePath("causal-graph-workbench", "/demo-projects/simple-confounding-demo.json")).toBe(
      "/causal-graph-workbench/demo-projects/simple-confounding-demo.json",
    );
  });

  test("defaults API requests to the local /api prefix", () => {
    expect(joinApiBase(undefined, "analyze")).toBe("/api/analyze");
  });

  test("accepts a Render service origin and appends the fixed /api prefix", () => {
    expect(joinApiBase("https://causal-graph-workbench-api.onrender.com", "/templates")).toBe(
      "https://causal-graph-workbench-api.onrender.com/api/templates",
    );
  });

  test("supports an absolute Render API base URL", () => {
    expect(joinApiBase("https://causal-graph-workbench-api.onrender.com/api/", "/templates")).toBe(
      "https://causal-graph-workbench-api.onrender.com/api/templates",
    );
  });
});
