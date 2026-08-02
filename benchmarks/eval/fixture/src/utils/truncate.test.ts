import { describe, expect, it } from "vitest";
import { truncate } from "./truncate";

describe("truncate", () => {
  it("不超长原样返回", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });
  it("超长截到 maxLength 并加省略号", () => {
    expect(truncate("abcdefg", 3)).toBe("abc…");
  });
});
