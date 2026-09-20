/**
 * Single sign-on end to end (Q57): the real app, the real engine, the real database and a fake
 * identity provider that signs real tokens. Covers the recipe in
 * Vibe-Auth/docs/INTEGRATION-PLAN.md §2.I plus what Recap adds on top of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { breakglassEnsure, breakglassRotate, makeAudit } from "@kisaesdevlab/vibe-auth";
import { buildApp } from "../src/app.js";
import { auditEvents, sessions, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { ADMIN_ROLE, BREAKGLASS_EMAIL, BREAKGLASS_USERNAME, createVibeAuthAudit, createVibeAuthUsers } from "../src/lib/vibeAuthUsers.js";
import { FakeIdp } from "./fake-idp.js";
import { Client, FakeEmailClient, FakeStager, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";

const available = await servicesAvailable();

const CLIENT_ID = "vibe-vibe-recap-test";
const CLIENT_SECRET = "s3cret-for-the-fake-idp";
const PUBLIC_URL = "http://recap.test";
const ADMIN_PASSWORD = "correct-horse-battery-staple";

function authEnv(idp: FakeIdp, mode: "local" | "both" | "oidc_only"): NodeJS.ProcessEnv {
  return {
    VIBE_AUTH_MODE: mode,
    VIBE_OIDC_ISSUER: idp.issuer,
    VIBE_OIDC_CLIENT_ID: CLIENT_ID,
    VIBE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    VIBE_OIDC_PUBLIC_URL: PUBLIC_URL,
  };
}

/** Walk the authorization-code flow: app -> fake IdP (auto-consents) -> app callback. */
async function ssoLogin(c: Client, idp: FakeIdp, returnTo?: string) {
  const start = await c.get(`/auth/oidc/start${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`);
  expect(start.statusCode).toBe(302);
  const authorize = String(start.headers.location);
  expect(authorize.startsWith(idp.issuer)).toBe(true);
  const consent = await fetch(authorize, { redirect: "manual" });
  const callback = new URL(consent.headers.get("location")!);
  expect(callback.origin).toBe(PUBLIC_URL);
  return c.get(callback.pathname + callback.search);
}

async function auditActions(ctx: TestContext, prefix: string) {
  const rows = await ctx.db.select().from(auditEvents).orderBy(auditEvents.id);
  return rows.filter((r) => r.action.startsWith(prefix));
}

describe.skipIf(!available)("single sign-on: off by default", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("reports local mode, refuses to start a sign-in, and leaves local login untouched", async () => {
    const c = new Client(ctx.app);
    const status = (await c.get("/auth/status")).json();
    expect(status).toMatchObject({ mode: "local", product: "vibe-recap", localLoginVisible: true, oidc: { enabled: false } });
    expect((await c.get("/auth/oidc/start")).statusCode).toBe(409);
    await c.setup();
    expect((await c.get("/api/auth/me")).json().sso).toBe(false);
  });

  it("the settings API is for admins only, and a write needs the CSRF token", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/auth/settings")).statusCode).toBe(403);

    const admin = new Client(ctx.app);
    await admin.login("admin@example.com", ADMIN_PASSWORD);
    await admin.post("/api/users", { email: "staff@example.com", name: "Staff", role: "staff", tempPassword: "a-temporary-password-1" });
    const staff = new Client(ctx.app);
    await staff.login("staff@example.com", "a-temporary-password-1");
    expect((await staff.get("/auth/settings")).statusCode).toBe(403);

    const page = await admin.get("/auth/settings");
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ mode: "local", roles: ["admin", "preparer", "staff", "viewer"], adminRole: "admin" });

    const csrf = admin.csrf;
    admin.csrf = null;
    expect((await admin.request("PUT", "/auth/settings", { idpName: "Firm SSO" })).statusCode).toBe(403);
    admin.csrf = csrf;
    expect((await admin.request("PUT", "/auth/settings", { idpName: "Firm SSO" })).statusCode).toBe(200);
  });

  it("stores the client secret wrapped with the master key, never in the clear", async () => {
    const admin = new Client(ctx.app);
    await admin.login("admin@example.com", ADMIN_PASSWORD);
    const res = await admin.request("PUT", "/auth/settings", { clientSecret: "plain-client-secret" });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("plain-client-secret");
    const [row] = await ctx.db.$client.unsafe("select value from auth_settings where key = 'vibe_auth'");
    const stored = row!.value as { clientSecretWrapped: string };
    expect(JSON.stringify(stored)).not.toContain("plain-client-secret");
    expect(await ctx.storage.unwrapSecret(stored.clientSecretWrapped)).toBe("plain-client-secret");
  });
});

describe.skipIf(!available)("single sign-on: both", () => {
  let ctx: TestContext;
  let idp: FakeIdp;
  beforeAll(async () => {
    idp = await new FakeIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: { sub: "unset" } }).start();
    ctx = await createTestContext({}, { authEnv: authEnv(idp, "both") });
    await new Client(ctx.app).setup();
  });
  afterAll(async () => {
    await ctx?.close();
    await idp?.stop();
  });

  it("shows both ways in", async () => {
    const status = (await new Client(ctx.app).get("/auth/status")).json();
    expect(status).toMatchObject({ mode: "both", localLoginVisible: true, breakglassPath: "/login/local", oidc: { enabled: true, startPath: "/auth/oidc/start" } });
  });

  it("creates an account on first sign-in with the mapped role, and the session is a normal Recap session", async () => {
    idp.user = { sub: "sub-maria", email: "Maria@Example.com", email_verified: true, name: "Maria Manager", groups: ["vibe-manager"] };
    const c = new Client(ctx.app);
    const done = await ssoLogin(c, idp, "/jobs/abc");
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe("/jobs/abc");
    expect(String(done.headers["set-cookie"])).toMatch(/recap_sid=.*HttpOnly.*SameSite=Strict/i);

    const me = (await c.get("/api/auth/me")).json();
    expect(me.user).toMatchObject({ email: "maria@example.com", name: "Maria Manager", role: "preparer", mustChangePassword: false });
    expect(me.sso).toBe(true);

    // The CSRF token arrives with /me; a state-changing call passes with it and fails without.
    expect((await c.request("PUT", "/api/auth/preferences", { voice: "af_bella" })).statusCode).toBe(403);
    c.csrf = me.csrfToken;
    expect((await c.request("PUT", "/api/auth/preferences", { voice: "af_bella" })).statusCode).toBe(200);

    const [row] = await ctx.db.select().from(sessions).where(eq(sessions.oidcSubject, "sub-maria"));
    expect(row).toMatchObject({ oidcIssuer: idp.issuer, oidcSid: "sid-sub-maria" });
    expect(row!.oidcIdTokenWrapped).toBeTruthy();
    expect(row!.oidcIdTokenWrapped).not.toMatch(/^eyJ/); // wrapped, not a bare JWT

    const [u] = await ctx.db.select().from(users).where(eq(users.email, "maria@example.com"));
    expect(u).toMatchObject({ ssoOnly: true, disabled: false });
    const names = (await auditActions(ctx, "vibe.auth.")).map((r) => r.action);
    expect(names).toEqual(expect.arrayContaining(["vibe.auth.user.provisioned", "vibe.auth.login.success"]));
  });

  it("links an existing local account by verified email and re-syncs its role", async () => {
    const admin = new Client(ctx.app);
    await admin.login("admin@example.com", ADMIN_PASSWORD);
    await admin.post("/api/users", { email: "sam@example.com", name: "Sam", role: "viewer", tempPassword: "a-temporary-password-1" });

    idp.user = { sub: "sub-sam", email: "sam@example.com", email_verified: true, groups: ["vibe-staff"] };
    const c = new Client(ctx.app);
    expect((await ssoLogin(c, idp)).statusCode).toBe(302);
    const me = (await c.get("/api/auth/me")).json();
    expect(me.user).toMatchObject({ email: "sam@example.com", role: "staff" });
    const [u] = await ctx.db.select().from(users).where(eq(users.email, "sam@example.com"));
    expect(u!.ssoOnly).toBe(false); // it had a local password before; linking does not take it away
  });

  it("refuses an unverified email, a user in no Vibe group, and a disabled account", async () => {
    idp.user = { sub: "sub-eve", email: "admin@example.com", email_verified: false, groups: ["vibe-admin"] };
    const unverified = await ssoLogin(new Client(ctx.app), idp);
    expect(unverified.statusCode).toBe(401);
    expect(unverified.headers["set-cookie"]).toBeUndefined();

    idp.user = { sub: "sub-nobody", email: "nobody@example.com", email_verified: true, groups: ["some-other-group"] };
    expect((await ssoLogin(new Client(ctx.app), idp)).statusCode).toBe(401);
    expect(await ctx.db.select().from(users).where(eq(users.email, "nobody@example.com"))).toHaveLength(0);

    await ctx.db.update(users).set({ disabled: true }).where(eq(users.email, "sam@example.com"));
    idp.user = { sub: "sub-sam", email: "sam@example.com", email_verified: true, groups: ["vibe-staff"] };
    expect((await ssoLogin(new Client(ctx.app), idp)).statusCode).toBe(401);
    await ctx.db.update(users).set({ disabled: false }).where(eq(users.email, "sam@example.com"));

    const reasons = (await auditActions(ctx, "vibe.auth.login.failure")).map((r) => r.meta.reason);
    expect(reasons).toEqual(expect.arrayContaining(["unverified_email", "no_role", "inactive"]));
  });

  it("never lets a role sync demote the last active admin", async () => {
    idp.user = { sub: "sub-admin", email: "admin@example.com", email_verified: true, groups: ["vibe-staff"] };
    const c = new Client(ctx.app);
    expect((await ssoLogin(c, idp)).statusCode).toBe(302);
    const [u] = await ctx.db.select().from(users).where(eq(users.email, "admin@example.com"));
    expect(u!.role).toBe("admin");
    const refused = (await auditActions(ctx, "vibe.auth.role.changed")).filter((r) => r.meta.refused === true);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.meta).toMatchObject({ why: "last_active_admin", to: "staff" });
  });

  it("an account that exists only through single sign-on cannot mint a local password from its mailbox", async () => {
    const admin = new Client(ctx.app);
    await admin.login("admin@example.com", ADMIN_PASSWORD);
    const enabled = await admin.request("PUT", "/api/settings/email", { email_provider: "emailit", emailit_api_key: "em_api_secret_value_1234", email_from: "recap@firm.example" });
    expect(enabled.statusCode).toBe(200);
    const before = ctx.email.sent.length;
    const res = await new Client(ctx.app).post("/api/auth/forgot-password", { email: "maria@example.com" });
    expect(res.statusCode).toBe(200); // the same answer as for anyone else
    expect(ctx.email.sent.length).toBe(before);
    const refused = await auditActions(ctx, "auth.password_reset_refused");
    expect(refused.at(-1)!.meta).toMatchObject({ why: "sso_only_account" });

    // An administrator can still decide to give that person a local password.
    const [maria] = await ctx.db.select().from(users).where(eq(users.email, "maria@example.com"));
    expect((await admin.post(`/api/users/${maria!.id}/send-reset-link`)).statusCode).toBe(200);
    expect(ctx.email.sent.length).toBe(before + 1);
    const [after] = await ctx.db.select().from(users).where(eq(users.id, maria!.id));
    expect(after!.ssoOnly).toBe(false);
  });

  it("back-channel logout ends the single sign-on sessions of that identity and nothing else", async () => {
    idp.user = { sub: "sub-sam", email: "sam@example.com", email_verified: true, groups: ["vibe-staff"] };
    const viaSso = new Client(ctx.app);
    await ssoLogin(viaSso, idp);
    const viaPassword = new Client(ctx.app);
    expect((await viaPassword.login("sam@example.com", "a-temporary-password-1")).statusCode).toBe(200);
    expect((await viaSso.get("/api/auth/me")).statusCode).toBe(200);

    const token = await idp.logoutToken({ sub: "sub-sam", sid: "sid-sub-sam" });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/oidc/backchannel",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `logout_token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect((await viaSso.get("/api/auth/me")).statusCode).toBe(401);
    expect((await viaPassword.get("/api/auth/me")).statusCode).toBe(200);

    // A replayed logout token is refused; a fresh sign-in afterwards works.
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/auth/oidc/backchannel",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `logout_token=${encodeURIComponent(token)}`,
    });
    expect(replay.statusCode).toBe(400);
    const again = new Client(ctx.app);
    expect((await ssoLogin(again, idp)).statusCode).toBe(302);
    expect((await again.get("/api/auth/me")).statusCode).toBe(200);
  });

  it("signs out locally or all the way to the identity provider", async () => {
    idp.user = { sub: "sub-sam", email: "sam@example.com", email_verified: true, groups: ["vibe-staff"] };
    const local = new Client(ctx.app);
    await ssoLogin(local, idp);
    const stay = await local.get("/auth/oidc/logout?local=1");
    expect(stay.statusCode).toBe(302);
    expect(stay.headers.location).toBe("/login");
    expect((await local.get("/api/auth/me")).statusCode).toBe(401);

    const full = new Client(ctx.app);
    await ssoLogin(full, idp);
    const out = await full.get("/auth/oidc/logout");
    expect(out.statusCode).toBe(302);
    const end = new URL(String(out.headers.location));
    expect(end.href.startsWith(`${idp.issuer}end-session/`)).toBe(true);
    expect(end.searchParams.get("id_token_hint")).toMatch(/^eyJ/);
    expect(end.searchParams.get("post_logout_redirect_uri")).toBe(`${PUBLIC_URL}/auth/oidc/logged-out`);
    expect((await full.get("/api/auth/me")).statusCode).toBe(401);
  });
});

describe.skipIf(!available)("single sign-on: oidc_only and break-glass", () => {
  let ctx: TestContext;
  let idp: FakeIdp;
  let breakglassPassword = "";

  /** A second app on the same database: the way a restart with a changed environment looks. */
  function boot(env: NodeJS.ProcessEnv) {
    return buildApp({ config: ctx.config, db: ctx.db, redis: ctx.redis, storage: ctx.storage, stager: new FakeStager(ctx.storage), emailClient: new FakeEmailClient(), authEnv: env });
  }

  beforeAll(async () => {
    idp = await new FakeIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: { sub: "unset" } }).start();
    ctx = await createTestContext({}, { authEnv: authEnv(idp, "both") });
  });
  afterAll(async () => {
    await ctx?.close();
    await idp?.stop();
  });

  it("refuses to start in oidc_only without a break-glass account", async () => {
    await expect(boot(authEnv(idp, "oidc_only"))).rejects.toThrow(/break-glass/);
  });

  it("the break-glass command creates an account that can sign in, and does not close first-run setup", async () => {
    const cli = { users: createVibeAuthUsers(ctx.db), audit: makeAudit(createVibeAuthAudit(ctx.db)), username: BREAKGLASS_USERNAME, adminRole: ADMIN_ROLE, email: BREAKGLASS_EMAIL, actor: "test" };
    const created = await breakglassEnsure(cli);
    expect(created.password).toBeTruthy();
    breakglassPassword = created.password!;
    expect((await breakglassEnsure(cli)).password).toBeUndefined(); // idempotent: exists, no new password

    const [row] = await ctx.db.select().from(users).where(eq(users.email, BREAKGLASS_EMAIL));
    expect(row).toMatchObject({ role: "admin", disabled: false, mustChangePassword: false, ssoOnly: false });

    const c = new Client(ctx.app);
    expect((await c.get("/api/setup/status")).json()).toEqual({ needed: true });
    await c.setup();
  });

  it("closes the local form to everyone but break-glass, which signs in by username and is audited", async () => {
    const app = await boot(authEnv(idp, "oidc_only"));
    try {
      const status = (await new Client(app).get("/auth/status")).json();
      expect(status).toMatchObject({ mode: "oidc_only", localLoginVisible: false });

      const admin = new Client(app);
      const refused = await admin.login("admin@example.com", ADMIN_PASSWORD);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().message).toMatch(/single sign-on/i);

      const bg = new Client(app);
      expect((await bg.login(BREAKGLASS_USERNAME, "not-the-password-at-all")).statusCode).toBe(401);
      const ok = await bg.login(BREAKGLASS_USERNAME, breakglassPassword);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().user).toMatchObject({ email: BREAKGLASS_EMAIL, role: "admin", mustChangePassword: false });
      expect(await auditActions(ctx, "vibe.auth.breakglass.used")).toHaveLength(1);

      // Setup would mint a local password nobody could use.
      await ctx.db.delete(users).where(eq(users.email, "admin@example.com"));
      const setup = await new Client(app).post("/api/setup", { email: "new@example.com", name: "New", password: ADMIN_PASSWORD });
      expect(setup.statusCode).toBe(403);

      // Single sign-on still works, and is how the first admin arrives here.
      idp.user = { sub: "sub-owner", email: "owner@example.com", email_verified: true, groups: ["vibe-admin"] };
      const owner = new Client(app);
      expect((await ssoLogin(owner, idp)).statusCode).toBe(302);
      expect((await owner.get("/api/auth/me")).json().user.role).toBe("admin");
    } finally {
      await app.close();
    }
  });

  it("the break-glass account cannot be disabled, demoted, reset or duplicated from Settings > Users", async () => {
    await ctx.db.insert(users).values({ email: "second@example.com", name: "Second", role: "admin", passwordHash: await hashPassword(ADMIN_PASSWORD) });
    const admin = new Client(ctx.app);
    expect((await admin.login("second@example.com", ADMIN_PASSWORD)).statusCode).toBe(200);
    const [bg] = await ctx.db.select().from(users).where(eq(users.email, BREAKGLASS_EMAIL));

    expect((await admin.request("PATCH", `/api/users/${bg!.id}`, { disabled: true })).statusCode).toBe(409);
    expect((await admin.request("PATCH", `/api/users/${bg!.id}`, { role: "viewer" })).statusCode).toBe(409);
    expect((await admin.post(`/api/users/${bg!.id}/reset-password`, { tempPassword: "a-temporary-password-1" })).statusCode).toBe(409);
    expect((await admin.post("/api/users", { email: BREAKGLASS_EMAIL, name: "Imposter", role: "admin" })).statusCode).toBe(409);

    // It is not "another admin": with only it left, the last real admin still cannot be demoted.
    await ctx.db.update(users).set({ disabled: true }).where(eq(users.email, "owner@example.com"));
    const [second] = await ctx.db.select().from(users).where(eq(users.email, "second@example.com"));
    expect((await admin.request("PATCH", `/api/users/${second!.id}`, { role: "staff" })).statusCode).toBe(400);

    const listed = (await admin.get("/api/users")).json().users as Array<{ email: string; breakglass: boolean }>;
    expect(listed.find((u) => u.email === BREAKGLASS_EMAIL)!.breakglass).toBe(true);
  });

  it("rotate issues a new password, clears a lockout, and the old one stops working", async () => {
    await ctx.db.update(users).set({ failedLogins: 9, lockedUntil: new Date(Date.now() + 600_000) }).where(eq(users.email, BREAKGLASS_EMAIL));
    const cli = { users: createVibeAuthUsers(ctx.db), audit: makeAudit(createVibeAuthAudit(ctx.db)), username: BREAKGLASS_USERNAME, adminRole: ADMIN_ROLE, email: BREAKGLASS_EMAIL, actor: "test" };
    const rotated = await breakglassRotate(cli);
    expect(rotated.password).toBeTruthy();
    expect(rotated.password).not.toBe(breakglassPassword);
    expect((await new Client(ctx.app).login(BREAKGLASS_USERNAME, breakglassPassword)).statusCode).toBe(401);
    expect((await new Client(ctx.app).login(BREAKGLASS_USERNAME, rotated.password!)).statusCode).toBe(200);
  });
});
