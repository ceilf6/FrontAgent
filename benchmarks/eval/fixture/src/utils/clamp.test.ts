import { describe, expect, it } from "vitest";
import { clamp } from "./clamp";

describe("clamp", () => {
  it("小于下界取下界", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });
  it("大于上界取上界", () => {
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it("区间内原样返回", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
