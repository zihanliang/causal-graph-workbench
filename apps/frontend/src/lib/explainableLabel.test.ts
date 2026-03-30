import { describe, expect, test } from "vitest";

import { getExplainableDisplayLabel, getExplainableKindLabel } from "./explainableLabel";

describe("explainable labels", () => {
  test("formats adjustment sets for user-facing labels", () => {
    const analysis = {
      paths: [],
      adjustmentSets: [{ id: "adj-1", variables: ["Z"], isMinimal: true }],
      estimatorRecommendations: [],
    };

    expect(getExplainableKindLabel({ kind: "adjustment", id: "adj-1" })).toBe("Adjustment set");
    expect(
      getExplainableDisplayLabel(
        analysis as never,
        { kind: "adjustment", id: "adj-1" },
      ),
    ).toBe("{Z}");
  });
});
