import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";

const available = await servicesAvailable();

describe.skipIf(!available)("appliance conventions: health path and origin allow-list", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ ALLOWED_ORIGIN: "https://recap.firm.example, https://recap.lan" });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("/api/v1/health answers 200 only when Postgres is migrated and Redis is up", async () => {
    const c = new Client(ctx.app);
    const res = await c.get("/api/v1/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checks: { postgres: true, redis: true } });
  });

  it("state-changing requests with a foreign Origin are refused; listed origins and no Origin pass", async () => {
    const c = new Client(ctx.app);
    const foreign = await c.post("/api/setup", { email: "x@example.com", name: "X", password: "correct-horse-battery-staple" }, { origin: "https://evil.example" });
    expect(foreign.statusCode).toBe(403);
    const listed = await c.post("/api/setup", { email: "admin@example.com", name: "Admin", password: "correct-horse-battery-staple" }, { origin: "https://recap.lan" });
    expect(listed.statusCode).toBe(201);
    // GETs are never origin-gated
    const status = await c.request("GET", "/api/setup/status", undefined, { origin: "https://evil.example" });
    expect(status.statusCode).toBe(200);
  });
});
