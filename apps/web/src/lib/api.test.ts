import { describe, expect, it } from "vitest";
import { buildHeaders } from "./api";

describe("api headers", () => {
  it("adds csrf only on state-changing requests", () => {
    expect(buildHeaders("GET", undefined, "tok")["x-csrf-token"]).toBeUndefined();
    expect(buildHeaders("POST", { a: 1 }, "tok")["x-csrf-token"]).toBe("tok");
    expect(buildHeaders("POST", { a: 1 }, "tok")["content-type"]).toBe("application/json");
  });
  it("lets the browser set multipart boundaries", () => {
    expect(buildHeaders("POST", new FormData(), "tok")["content-type"]).toBeUndefined();
  });
});
