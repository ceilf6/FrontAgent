import { describe, expect, it } from "vitest";
import { pluralize } from "./pluralize";

describe("pluralize", () => {
  it("单数不加 s", () => {
    expect(pluralize("item", 1)).toBe("1 item");
  });
  it("复数加 s", () => {
    expect(pluralize("item", 2)).toBe("2 items");
  });
});
