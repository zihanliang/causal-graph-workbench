import { describe, expect, test } from "vitest";

import { joinApiBase, joinBasePath } from "./urls";

describe("deployment URL helpers", () => {
  test("joins a GitHub Pages base path to public assets", () => {
    expect(joinBasePath("/dag-workbench/", "demo-data/simple-confounding-study.csv")).toBe(
      "/dag-workbench/demo-data/simple-confounding-study.csv",
    );
  });

  test("normalizes a base path without leading or trailing slashes", () => {
    expect(joinBasePath("dag-workbench", "/demo-projects/simple-confounding-demo.json")).toBe(
      "/dag-workbench/demo-projects/simple-confounding-demo.json",
    );
  });

  test("defaults API requests to the local /api prefix", () => {
    expect(joinApiBase(undefined, "analyze")).toBe("/api/analyze");
  });

  test("supports an absolute Render API base URL", () => {
    expect(joinApiBase("https://dag-workbench-api.onrender.com/api/", "/templates")).toBe(
      "https://dag-workbench-api.onrender.com/api/templates",
    );
  });
});
