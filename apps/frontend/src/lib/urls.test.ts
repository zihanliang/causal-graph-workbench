import { describe, expect, test } from "vitest";

import { joinBasePath } from "./urls";

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
});
