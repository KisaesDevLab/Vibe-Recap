import { promises as fs } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { licenses, users } from "../src/db/schema.js";
import { checkLicense, currentState, type LicenseClient } from "../src/services/license.js";

const available = await servicesAvailable();

class FakeLicense implements LicenseClient {
  mode: "valid" | "invalid" | "down" = "valid";
  calls = 0;
  async validate() {
    this.calls++;
    if (this.mode === "down") throw new Error("ECONNREFUSED");
    if (this.mode === "invalid") return { valid: false, message: "key revoked" };
    return { valid: true, expires_at: new Date(Date.now() + 365 * 86400_000).toISOString(), max_seats: 3 };
  }
}

describe.skipIf(!available)("users, invites, licensing, settings backup", () => {
  let ctx: TestContext;
  let admin: Client;
  const fake = new FakeLicense();

  beforeAll(async () => {
    ctx = await createTestContext();
    // rebuild the app with the fake licensing client and enforcement on
    await ctx.app.close();
    const { buildApp } = await import("../src/app.js");
    const { createRedis } = await import("../src/services/redis.js");
    const redis = createRedis(ctx.config.REDIS_URL);
    ctx.app = await buildApp({ config: ctx.config, db: ctx.db, redis, storage: ctx.storage, stager: ctx.stager, licenseClient: fake, enforceLicense: true });
    await ctx.app.ready();
    admin = new Client(ctx.app);
    await admin.setup();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("unlicensed installs are read-only except for auth, setup, invites, and the license key", async () => {
    const denied = await admin.post("/api/clients", { name: "Blocked, Client" });
    expect(denied.statusCode).toBe(402);
    const lic = await admin.request("PUT", "/api/settings/license", { key: "RECAP-TEST-KEY-0001" });
    expect(lic.statusCode, lic.body).toBe(200);
    expect(lic.json().status).toBe("valid");
    expect(lic.json().key).toBeUndefined();
    expect(lic.json().keyMasked).toBe("RECA…0001");
    const allowed = await admin.post("/api/clients", { name: "Allowed, Client" });
    expect(allowed.statusCode).toBe(201);
  });

  it("grace: unreachable server keeps the license valid for 14 days, then read-only", async () => {
    fake.mode = "down";
    const t = Date.now();
    let st = await checkLicense(ctx.app, fake, new Date(t + 1 * 86400_000));
    expect(st.status).toBe("grace");
    expect(st.readOnly).toBe(false);
    st = await checkLicense(ctx.app, fake, new Date(t + 15 * 86400_000));
    expect(await currentState(ctx.app, new Date(t + 15 * 86400_000)).then((s) => s.status)).toBe("invalid");
    fake.mode = "invalid";
    st = await checkLicense(ctx.app, fake);
    expect(st.status).toBe("invalid");
    expect(st.message).toMatch(/revoked/);
    fake.mode = "valid";
    st = await checkLicense(ctx.app, fake);
    expect(st.status).toBe("valid");
    const rows = await ctx.db.select().from(licenses);
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it("creates users with a temp password or an invite link, and enforces last-admin protection", async () => {
    const me = (await admin.get("/api/auth/me")).json().user;
    const demote = await admin.request("PATCH", `/api/users/${me.id}`, { role: "staff" });
    expect(demote.statusCode).toBe(400);
    const disable = await admin.request("PATCH", `/api/users/${me.id}`, { disabled: true });
    expect(disable.statusCode).toBe(400);

    const withPw = await admin.post("/api/users", { email: "p@example.com", name: "P", role: "preparer", tempPassword: "temporary-password-long" });
    expect(withPw.statusCode).toBe(201);
    expect(withPw.json().inviteUrl).toBeNull();
    const [row] = await ctx.db.select().from(users).where(eq(users.email, "p@example.com"));
    expect(row!.mustChangePassword).toBe(true);

    const invited = await admin.post("/api/users", { email: "i@example.com", name: "I", role: "staff" });
    expect(invited.statusCode).toBe(201);
    const url = invited.json().inviteUrl as string;
    expect(url).toMatch(/^\/invite\//);
    const token = url.split("/").pop()!;
    const anon = new Client(ctx.app);
    expect((await anon.get(`/api/invite/${token}`)).json().email).toBe("i@example.com");
    const weak = await anon.post(`/api/invite/${token}`, { password: "password1234" });
    expect(weak.statusCode).toBe(400);
    const ok = await anon.post(`/api/invite/${token}`, { password: "a-fine-invite-password" });
    expect(ok.statusCode).toBe(200);
    expect((await anon.get(`/api/invite/${token}`)).statusCode).toBe(404); // single use
    const login = await anon.login("i@example.com", "a-fine-invite-password");
    expect(login.statusCode).toBe(200);

    // invite expiry: 24 h TTL on the redis key
    const another = await admin.post("/api/users", { email: "j@example.com", name: "J", role: "viewer" });
    const token2 = (another.json().inviteUrl as string).split("/").pop()!;
    const ttl = await ctx.app.redis.ttl(`invite:${token2}`);
    expect(ttl).toBeGreaterThan(23 * 3600);
    await ctx.app.redis.del(`invite:${token2}`);
    expect((await anon.get(`/api/invite/${token2}`)).statusCode).toBe(404);

    // seats: 3 licensed, now 4 active users -> message after the next check
    const st = await checkLicense(ctx.app, fake);
    expect(st.status).toBe("valid");
    expect(st.seatsInUse).toBe(4);
    expect(st.message).toMatch(/Seat count exceeded/);
  });

  it("promoting a second admin then demoting the first works; force logout drops sessions; reset password forces change", async () => {
    const me = (await admin.get("/api/auth/me")).json().user;
    const [p] = await ctx.db.select().from(users).where(eq(users.email, "p@example.com"));
    expect((await admin.request("PATCH", `/api/users/${p!.id}`, { role: "admin" })).statusCode).toBe(200);
    expect((await admin.request("PATCH", `/api/users/${me.id}`, { role: "preparer" })).statusCode).toBe(200);
    await admin.request("PATCH", `/api/users/${me.id}`, { role: "admin" }).catch(() => undefined); // now a preparer: refused
    // log in as the new admin to continue
    const second = new Client(ctx.app);
    await ctx.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, p!.id));
    await second.login("p@example.com", "temporary-password-long");
    expect((await second.request("PATCH", `/api/users/${me.id}`, { role: "admin" })).statusCode).toBe(200);
    const fl = await second.post(`/api/users/${me.id}/force-logout`);
    expect(fl.statusCode).toBe(200);
    expect(fl.json().sessions).toBeGreaterThanOrEqual(1);
    expect((await admin.get("/api/auth/me")).statusCode).toBe(401);
    const reset = await second.post(`/api/users/${me.id}/reset-password`, { tempPassword: "another-temp-password" });
    expect(reset.statusCode).toBe(200);
    await admin.login("admin@example.com", "another-temp-password");
    expect((await admin.get("/api/auth/me")).statusCode).toBe(200);
  });

  it("audit log is filterable and exportable; settings export/import round-trips with profiles", async () => {
    const list = await admin.get("/api/audit?action=user.&pageSize=10");
    expect(list.statusCode).toBe(200);
    expect(list.json().events.every((e: { action: string }) => e.action.startsWith("user."))).toBe(true);
    expect(list.json().total).toBeGreaterThan(3);
    const csv = await admin.get("/api/audit/export.csv?action=license.");
    expect(csv.body.split("\n")[0]).toBe("id,at,actor,action,target_type,target_id,ip,meta");

    await fs.mkdir(path.join(ctx.dataDir, "form-profiles"), { recursive: true });
    await fs.writeFile(path.join(ctx.dataDir, "form-profiles", "1040-2025-test.yaml"), "extends: _base-1040.yaml\nsoftware: test\n");
    await admin.request("PUT", "/api/settings/general", { firm_name: "Round Trip CPA", voice: "am_adam", color_primary: "#112233" });
    const exp = await admin.get("/api/settings/backup/export");
    expect(exp.statusCode).toBe(200);
    const doc = exp.json();
    expect(doc.settings.firm_name).toBe("Round Trip CPA");
    expect(doc.settings.license_key).toBeUndefined();
    expect(doc.profiles["1040-2025-test.yaml"]).toContain("software: test");

    await admin.request("PUT", "/api/settings/general", { firm_name: "Changed", voice: "af_bella" });
    await fs.rm(path.join(ctx.dataDir, "form-profiles", "1040-2025-test.yaml"));
    const imp = await admin.post("/api/settings/backup/import", { mode: "replace", settings: doc.settings, profiles: doc.profiles });
    expect(imp.statusCode, imp.body).toBe(200);
    const after = await admin.get("/api/settings/general");
    expect(after.json().settings.firm_name).toBe("Round Trip CPA");
    expect(after.json().settings.voice).toBe("am_adam");
    expect(await fs.readFile(path.join(ctx.dataDir, "form-profiles", "1040-2025-test.yaml"), "utf8")).toContain("software: test");
    const lic = await ctx.db.execute<{ value: unknown }>(sql`select value from settings where key = 'license_key'`);
    expect(lic[0]!.value).toBe("RECAP-TEST-KEY-0001"); // import never touches the key
  });

  it("test-ollama reports reachability without throwing", async () => {
    const res = await admin.post("/api/settings/test-ollama", { ollama_url: "http://127.0.0.1:9" });
    expect(res.statusCode).toBe(200);
    expect(res.json().reachable).toBe(false);
  });
});
