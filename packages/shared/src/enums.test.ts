import { describe, expect, it } from "vitest";
import { roleAtLeast, JOB_STEPS } from "./enums.js";

describe("roles", () => {
  it("orders privilege", () => {
    expect(roleAtLeast("admin", "preparer")).toBe(true);
    expect(roleAtLeast("staff", "preparer")).toBe(false);
    expect(roleAtLeast("preparer", "preparer")).toBe(true);
  });
  it("pipeline order is fixed", () => {
    expect(JOB_STEPS.indexOf("validate")).toBeLessThan(JOB_STEPS.indexOf("verify"));
    expect(JOB_STEPS.indexOf("verify")).toBeLessThan(JOB_STEPS.indexOf("tts"));
  });
});
