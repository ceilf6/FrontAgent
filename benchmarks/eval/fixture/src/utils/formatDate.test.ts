import { describe, expect, it } from "vitest";
import { formatDate } from "./formatDate";

describe("formatDate", () => {
  it("格式化为 YYYY-MM-DD", () => {
    expect(formatDate(new Date(2026, 6, 11))).toBe("2026-07-11");
  });
});
