import { describe, expect, it } from "vitest";
import { checkPasswordPolicy, commonPasswordListSize, hashPassword, verifyPassword } from "../src/auth/password.js";

describe("password", () => {
  it("bundles the common password list", () => {
    expect(commonPasswordListSize()).toBeGreaterThan(50_000);
  });
  it("enforces length and breach list", () => {
    expect(checkPasswordPolicy("short")).toMatch(/at least 12/);
    expect(checkPasswordPolicy("password1234")).toMatch(/commonly breached/);
    expect(checkPasswordPolicy("correct-horse-battery-staple")).toBeNull();
  });
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct-horse-battery-staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
    expect(await verifyPassword("garbage", "x")).toBe(false);
  });
});
