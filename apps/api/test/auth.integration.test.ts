import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";

const available = await servicesAvailable();

describe.skipIf(!available)("setup and auth", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("setup is needed on an empty database and disappears after the first admin", async () => {
    const c = new Client(ctx.app);
    expect((await c.get("/api/setup/status")).json()).toEqual({ needed: true });
    await c.setup();
    expect((await c.get("/api/setup/status")).json()).toEqual({ needed: false });
    const again = await c.post("/api/setup", { email: "x@example.com", name: "X", password: "another-long-password-1" });
    expect(again.statusCode).toBe(409);
  });

  it("rejects weak passwords at setup", async () => {
    const c = new Client(ctx.app);
    const res = await c.post("/api/setup", { email: "x@example.com", name: "X", password: "password1234" });
    expect(res.statusCode).toBe(400);
  });

  it("login works, me returns the user, logout clears the session", async () => {
    const c = new Client(ctx.app);
    const bad = await c.login("admin@example.com", "nope-nope-nope");
    expect(bad.statusCode).toBe(401);
    const ok = await c.login("admin@example.com", "correct-horse-battery-staple");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.role).toBe("admin");
    const me = await c.get("/api/auth/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("admin@example.com");
    expect((await c.post("/api/auth/logout")).statusCode).toBe(200);
    expect((await c.get("/api/auth/me")).statusCode).toBe(401);
  });

  it("a user picks their own narration voice, and an unknown voice is rejected", async () => {
    const c = new Client(ctx.app);
    await c.login("admin@example.com", "correct-horse-battery-staple");
    expect((await c.get("/api/auth/me")).json().user.voice).toBe(null);
    const set = await c.request("PUT", "/api/auth/preferences", { voice: "am_michael" });
    expect(set.statusCode).toBe(200);
    expect((await c.get("/api/auth/me")).json().user.voice).toBe("am_michael");
    const bad = await c.request("PUT", "/api/auth/preferences", { voice: "not_a_voice" });
    expect(bad.statusCode).toBe(400);
    await c.request("PUT", "/api/auth/preferences", { voice: null });
    expect((await c.get("/api/auth/me")).json().user.voice).toBe(null);
  });

  it("rejects state-changing requests without the CSRF header", async () => {
    const c = new Client(ctx.app);
    await c.login("admin@example.com", "correct-horse-battery-staple");
    c.csrf = null;
    const res = await c.post("/api/auth/logout");
    expect(res.statusCode).toBe(403);
    const wrong = await c.post("/api/auth/logout", undefined, { "x-csrf-token": "bogus" });
    expect(wrong.statusCode).toBe(403);
  });

  it("locks the account after repeated failures", async () => {
    const c = new Client(ctx.app);
    for (let i = 0; i < 9; i++) {
      // A different X-Forwarded-For per attempt so the IP rate limit does not mask the lockout.
      const res = await c.post("/api/auth/login", { email: "admin@example.com", password: "wrong-password-x" }, { "x-forwarded-for": `10.0.0.${i + 1}` });
      expect(res.statusCode).toBe(401);
    }
    const tenth = await c.post("/api/auth/login", { email: "admin@example.com", password: "wrong-password-x" }, { "x-forwarded-for": "10.0.0.20" });
    expect(tenth.statusCode).toBe(401);
    const locked = await c.post("/api/auth/login", { email: "admin@example.com", password: "correct-horse-battery-staple" }, { "x-forwarded-for": "10.0.0.21" });
    expect(locked.statusCode).toBe(423);
  });

  it("rate limits login per IP", async () => {
    const c = new Client(ctx.app);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await c.post("/api/auth/login", { email: "nobody@example.com", password: "whatever-whatever" }, { "x-forwarded-for": "10.9.9.9" });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it("serves health and readiness", async () => {
    const c = new Client(ctx.app);
    expect((await c.get("/healthz")).statusCode).toBe(200);
    const ready = await c.get("/readyz");
    expect([200, 503]).toContain(ready.statusCode);
    expect(ready.json().checks.postgres).toBe(true);
  });
});
