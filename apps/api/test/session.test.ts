import { describe, expect, it } from "vitest";
import { isExpired } from "../src/auth/session.js";
import type { Session } from "../src/db/schema.js";

const policy = { idleHours: 12, absoluteDays: 7 };
const t0 = new Date("2026-09-05T12:00:00Z");
const mk = (over: Partial<Session>): Session => ({
  id: "s",
  userId: "u",
  csrfToken: "c",
  createdAt: t0,
  lastSeenAt: t0,
  expiresAt: new Date(t0.getTime() + 7 * 86400_000),
  ip: null,
  userAgent: null,
  ...over,
});

describe("session expiry", () => {
  it("is live within idle and absolute windows", () => {
    expect(isExpired(mk({}), policy, new Date(t0.getTime() + 11 * 3600_000))).toBe(false);
  });
  it("expires after 12h idle", () => {
    expect(isExpired(mk({}), policy, new Date(t0.getTime() + 12 * 3600_000))).toBe(true);
  });
  it("expires at the 7d absolute limit even when recently active", () => {
    const lastSeen = new Date(t0.getTime() + 7 * 86400_000 - 60_000);
    expect(isExpired(mk({ lastSeenAt: lastSeen }), policy, new Date(t0.getTime() + 7 * 86400_000))).toBe(true);
  });
});
