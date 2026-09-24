import { describe, expect, it } from "vitest";
import { parseMoney } from "./ExtractionOverrides";

describe("parseMoney", () => {
  it("reads amounts the way a return prints them", () => {
    expect(parseMoney("746")).toBe(746);
    expect(parseMoney("$5,400")).toBe(5400);
    expect(parseMoney(" 1,234 ")).toBe(1234);
    expect(parseMoney("0")).toBe(0);
    expect(parseMoney("12.50")).toBe(13);
  });

  it("reads losses in each notation", () => {
    expect(parseMoney("(3,000)")).toBe(-3000);
    expect(parseMoney("-3000")).toBe(-3000);
    expect(parseMoney("3,000-")).toBe(-3000);
  });

  it("refuses anything that is not a dollar amount", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("1.2.3")).toBeNull();
    expect(parseMoney("12.345")).toBeNull();
    expect(parseMoney("5%")).toBeNull();
  });
});
