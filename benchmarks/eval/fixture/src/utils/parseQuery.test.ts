import { describe, expect, it } from "vitest";
import { parseQuery } from "./parseQuery";

describe("parseQuery", () => {
  it("解析问号前缀查询串", () => {
    expect(parseQuery("?a=1&b=2")).toEqual({ a: "1", b: "2" });
  });
  it("URL 编码的值要解码", () => {
    expect(parseQuery("q=hello%20world")).toEqual({ q: "hello world" });
  });
  it("空串返回空对象", () => {
    expect(parseQuery("")).toEqual({});
  });
});
