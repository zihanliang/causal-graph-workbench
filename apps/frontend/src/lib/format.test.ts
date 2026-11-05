import { describe, expect, test } from "vitest";

import { formatNumber } from "./format";

describe("formatNumber", () => {
  test.each([
    [4.6298, "4.630"],
    [-0.2, "-0.200"],
    [0, "0.000"],
    [12.345, "12.35"],
    [123.45, "123.5"],
    [12345.6, "12,346"],
  ])("ordinary numbers: %f", (value, expected) => {
    expect(formatNumber(value)).toBe(expected);
  });

  test("a small effect is not shown as zero", () => {
    expect(formatNumber(0.00042)).toBe("0.000420");
    expect(formatNumber(-0.00042)).toBe("-0.000420");
    expect(formatNumber(1.2e-9)).toBe("1.20e-9");
  });

  test("a huge number does not run to hundreds of digits", () => {
    expect(formatNumber(2.5e200)).toBe("2.50e+200");
    expect(formatNumber(1e7)).toBe("1.00e+7");
    expect(formatNumber(9_999_999)).toBe("9,999,999");
  });

  test("what is not a number says so", () => {
    expect(formatNumber(Number.NaN)).toBe("n/a");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});
