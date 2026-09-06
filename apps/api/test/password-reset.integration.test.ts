import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { auditEvents, users } from "../src/db/schema.js";

const available = await servicesAvailable();

const ADMIN = "admin@example.com";
const ADMIN_PW = "correct-horse-battery-staple";

function tokenOf(link: string): string {
  const m = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(link);
  if (!m) throw new Error(`not a reset link: ${link}`);
  return m[1]!;
}

describe.skipIf(!available)("outgoing email, password reset, change password", () => {
  let ctx: TestContext;
  let admin: Client;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    await admin.setup(ADMIN, ADMIN_PW);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("is off until an admin configures a provider; forgot-password says so", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/auth/password-reset/status")).json()).toEqual({ enabled: false });
    const res = await anon.post("/api/auth/forgot-password", { email: ADMIN });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not enabled/);
    expect(ctx.email.sent).toHaveLength(0);
    const link = await admin.post(`/api/users/${(await admin.get("/api/auth/me")).json().user.id}/send-reset-link`);
    expect(link.statusCode).toBe(400);
  });

  it("email settings: masked key, validation, test message, excluded from export", async () => {
    let res = await admin.request("PUT", "/api/settings/email", { email_provider: "emailit", emailit_api_key: "em_api_secret_value_1234", email_from: "not an address" });
    expect(res.statusCode).toBe(400);
    res = await admin.request("PUT", "/api/settings/email", { email_provider: "emailit", emailit_api_key: "em_api_secret_value_1234", email_from: "recap@firm.example", email_from_name: "Smith CPA", public_url: "https://recap.firm.example/" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().enabled).toBe(true);
    expect(res.json().apiKeySet).toBe(true);
    expect(res.json().apiKeyMasked).toBe("em_api…1234");
    expect(JSON.stringify(res.json())).not.toContain("em_api_secret_value_1234");
    expect(res.json().settings.public_url).toBe("https://recap.firm.example");

    const test = await admin.post("/api/settings/email/test", {});
    expect(test.statusCode, test.body).toBe(200);
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.last()!.to).toBe(ADMIN);
    expect(ctx.email.last()!.from).toBe("Smith CPA <recap@firm.example>");
    expect(ctx.email.last()!.apiKey).toBe("em_api_secret_value_1234");
    expect(ctx.email.last()!.text).toContain("https://recap.firm.example");

    const exp = await admin.get("/api/settings/backup/export");
    expect(exp.statusCode).toBe(200);
    expect(exp.json().settings.emailit_api_key).toBeUndefined();
    expect(exp.json().settings.license_key).toBeUndefined();
    expect(exp.json().settings.email_from).toBe("recap@firm.example");

    // an import cannot smuggle a key in
    const imp = await admin.post("/api/settings/backup/import", { settings: { emailit_api_key: "em_api_injected" } });
    expect(imp.statusCode).toBe(200);
    expect((await admin.get("/api/settings/email")).json().apiKeyMasked).toBe("em_api…1234");

    // a save without the key field keeps the key; an empty string clears it (then restore)
    await admin.request("PUT", "/api/settings/email", { email_reply_to: "office@firm.example" });
    expect((await admin.get("/api/settings/email")).json().apiKeySet).toBe(true);
    await admin.request("PUT", "/api/settings/email", { emailit_api_key: "" });
    expect((await admin.get("/api/settings/email")).json().apiKeySet).toBe(false);
    expect((await admin.get("/api/settings/email")).json().enabled).toBe(false);
    await admin.request("PUT", "/api/settings/email", { emailit_api_key: "em_api_secret_value_1234" });
    ctx.email.sent = [];
  });

  it("a test send failure is reported, not swallowed", async () => {
    ctx.email.fail = "Emailit refused the message: Unauthenticated (check the API key)";
    const test = await admin.post("/api/settings/email/test", { to: "someone@firm.example" });
    expect(test.statusCode).toBe(400);
    expect(test.json().message).toMatch(/check the API key/);
    ctx.email.fail = null;
  });

  it("forgot-password answers the same for unknown and known addresses and mails only the known one", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/auth/password-reset/status")).json()).toEqual({ enabled: true });
    const unknown = await anon.post("/api/auth/forgot-password", { email: "nobody@firm.example" }, { "x-forwarded-for": "10.1.1.1" });
    expect(unknown.statusCode).toBe(200);
    const known = await anon.post("/api/auth/forgot-password", { email: ADMIN.toUpperCase() }, { "x-forwarded-for": "10.1.1.2" });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual(unknown.json());
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.last()!.to).toBe(ADMIN);
    expect(ctx.email.lastLink()).toMatch(/^https:\/\/recap\.firm\.example\/reset-password\/[A-Za-z0-9_-]{40,}$/);
    // token is not stored in the clear
    const keys = await ctx.app.redis.keys("pwreset:*");
    expect(keys.some((k) => k.includes(tokenOf(ctx.email.lastLink())))).toBe(false);
  });

  it("the link previews the account, rejects weak passwords, resets once, and ends every session", async () => {
    // a second request replaces the first link
    const anon = new Client(ctx.app);
    const first = ctx.email.lastLink();
    await anon.post("/api/auth/forgot-password", { email: ADMIN }, { "x-forwarded-for": "10.1.1.3" });
    const link = ctx.email.lastLink();
    expect(link).not.toBe(first);
    expect((await anon.get(`/api/auth/reset-password/${tokenOf(first)}`)).statusCode).toBe(404);

    const preview = await anon.get(`/api/auth/reset-password/${tokenOf(link)}`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ email: ADMIN, name: "Admin" });

    const weak = await anon.post(`/api/auth/reset-password/${tokenOf(link)}`, { password: "password1234" });
    expect(weak.statusCode).toBe(400);

    // the admin is signed in elsewhere; that session must die
    expect((await admin.get("/api/auth/me")).statusCode).toBe(200);
    ctx.email.sent = [];
    const ok = await anon.post(`/api/auth/reset-password/${tokenOf(link)}`, { password: "a-brand-new-passphrase-2026" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await admin.get("/api/auth/me")).statusCode).toBe(401);
    // single use
    expect((await anon.post(`/api/auth/reset-password/${tokenOf(link)}`, { password: "another-new-passphrase-2026" })).statusCode).toBe(404);
    // the notice went out
    expect(ctx.email.sent.map((m) => m.subject)).toEqual(["Your Vibe Recap password was changed"]);

    expect((await admin.login(ADMIN, ADMIN_PW)).statusCode).toBe(401);
    expect((await admin.login(ADMIN, "a-brand-new-passphrase-2026")).statusCode).toBe(200);
    const rows = await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, "user.password_reset_self"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("a-brand-new-passphrase");
  });

  it("disabled users get no link and a stale link stops working when the user is disabled", async () => {
    const created = await admin.post("/api/users", { email: "gone@firm.example", name: "Gone", role: "staff", tempPassword: "temporary-passphrase-xyz" });
    expect(created.statusCode).toBe(201);
    const id = created.json().user.id;
    ctx.email.sent = [];
    const anon = new Client(ctx.app);
    await anon.post("/api/auth/forgot-password", { email: "gone@firm.example" }, { "x-forwarded-for": "10.1.1.4" });
    const link = ctx.email.lastLink();
    await admin.request("PATCH", `/api/users/${id}`, { disabled: true });
    expect((await anon.get(`/api/auth/reset-password/${tokenOf(link)}`)).statusCode).toBe(404);
    expect((await anon.post(`/api/auth/reset-password/${tokenOf(link)}`, { password: "a-perfectly-fine-passphrase" })).statusCode).toBe(404);
    ctx.email.sent = [];
    expect((await anon.post("/api/auth/forgot-password", { email: "gone@firm.example" }, { "x-forwarded-for": "10.1.1.5" })).statusCode).toBe(200);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it("admins can email a reset link, and invites are emailed with the link still returned", async () => {
    ctx.email.sent = [];
    const invited = await admin.post("/api/users", { email: "new@firm.example", name: "New Person", role: "preparer" });
    expect(invited.statusCode, invited.body).toBe(201);
    expect(invited.json().emailed).toBe(true);
    expect(invited.json().inviteUrl).toMatch(/^\/invite\//);
    expect(ctx.email.last()!.to).toBe("new@firm.example");
    expect(ctx.email.lastLink()).toBe(`https://recap.firm.example${invited.json().inviteUrl}`);
    expect(ctx.email.last()!.text).toContain("preparer");

    const me = (await admin.get("/api/auth/me")).json().user;
    ctx.email.sent = [];
    const sent = await admin.post(`/api/users/${me.id}/send-reset-link`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(ctx.email.last()!.to).toBe(ADMIN);
    const audits = await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, "user.password_reset_link_sent"));
    expect(audits).toHaveLength(1);

    // sendEmail:false keeps the old behaviour of a link only
    ctx.email.sent = [];
    const quiet = await admin.post("/api/users", { email: "quiet@firm.example", name: "Quiet", role: "viewer", sendEmail: false });
    expect(quiet.json().emailed).toBe(false);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it("change-password requires the current password, keeps this session, ends the others, and clears must-change", async () => {
    const [row] = await ctx.db.select().from(users).where(eq(users.email, ADMIN));
    await ctx.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, row!.id));
    expect((await admin.get("/api/auth/me")).json().user.mustChangePassword).toBe(true);
    const other = new Client(ctx.app);
    expect((await other.login(ADMIN, "a-brand-new-passphrase-2026")).statusCode).toBe(200);
    const wrong = await admin.post("/api/auth/change-password", { currentPassword: "not-it-at-all-really", newPassword: "yet-another-fine-passphrase" });
    expect(wrong.statusCode).toBe(401);
    ctx.email.sent = [];
    const ok = await admin.post("/api/auth/change-password", { currentPassword: "a-brand-new-passphrase-2026", newPassword: "yet-another-fine-passphrase" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await admin.get("/api/auth/me")).statusCode).toBe(200);
    expect((await admin.get("/api/auth/me")).json().user.mustChangePassword).toBe(false);
    expect((await other.get("/api/auth/me")).statusCode).toBe(401);
    expect(ctx.email.sent.map((m) => m.subject)).toEqual(["Your Vibe Recap password was changed"]);
  });
});
