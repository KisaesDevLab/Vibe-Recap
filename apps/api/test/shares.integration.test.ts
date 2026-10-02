import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, files, jobShares, jobs, shareEvents, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { setSetting } from "../src/services/settings.js";
import { sweepShares } from "../src/services/shares.js";
import { runPurge } from "../src/services/purge.js";
import { maskUrl } from "../src/logger.js";

const available = await servicesAvailable();
const WATCH = "https://watch.example.com";

describe.skipIf(!available)("client sharing (Q73)", () => {
  let ctx: TestContext;
  let admin: Client;
  let staff: Client;
  let ipSeq = 1;
  const video = Buffer.from("\x00\x00\x00\x18ftypmp42" + "v".repeat(5000));
  const vtt = Buffer.from("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhello\n");

  async function seedJob(status: "approved" | "needs_review" | "released" = "approved"): Promise<string> {
    const me = (await admin.get("/api/auth/me")).json();
    const [client] = await ctx.db.insert(clients).values({ name: "Fixture, Alex", normalizedName: "fixture alex" }).returning();
    const [job] = await ctx.db.insert(jobs).values({ status, step: "ready", clientId: client!.id, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025, approvedScriptSha256: "b".repeat(64), readyAt: new Date() }).returning();
    for (const [kind, data] of [["video", video], ["vtt", vtt]] as const) {
      const blob = await ctx.storage.put(job!.id, data);
      await ctx.db.insert(files).values({ id: blob.id, jobId: job!.id, kind, path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
    }
    return job!.id;
  }

  /** A fresh client IP per call keeps the per-IP rate limits out of the way of the per-share counters under test. */
  function watcher() {
    const c = new Client(ctx.app);
    const send = (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) =>
      c.request(method, url, body, { "x-forwarded-for": `203.0.113.${ipSeq++ % 250}`, "user-agent": "Mozilla/5.0 test", ...headers });
    return { c, get: (url: string, h?: Record<string, string>) => send("GET", url, undefined, h), post: (url: string, body?: unknown, h?: Record<string, string>) => send("POST", url, body ?? {}, h) };
  }

  function linkPath(text: string): string {
    const m = /https:\/\/watch\.example\.com(\/watch\/[A-Za-z0-9_-]{43})/.exec(text);
    if (!m) throw new Error(`no watch link in: ${text}`);
    return m[1]!;
  }

  function lastCode(text: string): string {
    const m = /\b(\d{6})\b/.exec(text);
    if (!m) throw new Error("no code");
    return m[1]!;
  }

  async function shareOf(jobId: string) {
    const rows = await ctx.db.select().from(jobShares).where(eq(jobShares.jobId, jobId)).orderBy(sql`created_at desc`);
    return rows[0]!;
  }

  beforeAll(async () => {
    ctx = await createTestContext({ ALLOWED_ORIGIN: "https://recap.example.com" });
    admin = new Client(ctx.app);
    await admin.setup();
    await ctx.db.insert(users).values({ email: "staff@example.com", name: "S", role: "staff", passwordHash: await hashPassword("staff-password-long") });
    staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    await setSetting(ctx.db, "firm_name", "Example CPA", null);
    await setSetting(ctx.db, "email_provider", "emailit", null);
    await setSetting(ctx.db, "emailit_api_key", "em_test_key", null);
    await setSetting(ctx.db, "email_from", "recap@example.com", null);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("refuses to share while sharing is off, and refuses unapproved jobs and staff", async () => {
    const jobId = await seedJob();
    const off = await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "client@example.net", requireSecret: false });
    expect(off.statusCode).toBe(400);
    expect(off.json().message).toMatch(/sharing is off/i);

    const put = await admin.request("PUT", "/api/settings/sharing", { share_enabled: true, share_public_url: `${WATCH}/` });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().status.enabled).toBe(true);

    expect((await staff.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "client@example.net", requireSecret: false })).statusCode).toBe(403);
    const review = await seedJob("needs_review");
    expect((await admin.post(`/api/jobs/${review}/shares`, { channel: "email", contact: "client@example.net", requireSecret: false })).statusCode).toBe(400);
    expect((await admin.post(`/api/jobs/${jobId}/shares`, { channel: "sms", contact: "5551234567", requireSecret: false })).json().message).toMatch(/text messages are not set up/i);
    expect((await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "client@example.net", requireSecret: true, last4: "12" })).statusCode).toBe(400);
  });

  it("share by email: link sent without names or figures, job released, page asks for a code", async () => {
    const jobId = await seedJob();
    const res = await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "Client@Example.net", requireSecret: true, last4: "6789" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().share.contactMasked).toBe("c•••@example.net");
    const msg = ctx.email.last()!;
    expect(msg.to).toBe("client@example.net");
    expect(msg.text).not.toMatch(/Fixture|Alex|6789/);
    const path = linkPath(msg.text);

    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("released");
    const rel = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'job.release' and target_id = ${jobId} and meta->>'via' = 'share'`);
    expect(Number(rel[0]!.n)).toBe(1);

    const share = await shareOf(jobId);
    expect(share.contactWrapped).not.toContain("client@example.net");
    expect(share.secretHash).toMatch(/^\$argon2id\$/);

    const w = watcher();
    const page = await w.get(path);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Send my code");
    expect(page.body).toContain("Last four digits");
    expect(page.body).not.toContain("<video");
    expect(page.body).toContain("Example CPA");
    expect((await w.get(`${path}/video.mp4`)).statusCode).toBe(403);
    expect((await w.get("/watch/" + "x".repeat(43))).statusCode).toBe(404);
  });

  it("code: sent to the contact on file, resend throttled; wrong answers cool down, the right ones open a session", async () => {
    const jobId = await seedJob();
    await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "two@example.net", requireSecret: true, last4: "4321" });
    const path = linkPath(ctx.email.last()!.text);
    const share = await shareOf(jobId);
    const w = watcher();

    const sent = await w.post(`${path}/code`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().sentTo).toBe("t•••@example.net");
    expect(ctx.email.last()!.to).toBe("two@example.net");
    const code = lastCode(ctx.email.last()!.subject);
    expect((await w.post(`${path}/code`)).statusCode).toBe(429);

    const wrong = code === "000000" ? "111111" : "000000";
    expect((await w.post(`${path}/verify`, { code: wrong, last4: "4321" })).statusCode).toBe(400);
    expect((await w.post(`${path}/verify`, { code, last4: "0000" })).statusCode).toBe(400);
    const third = await w.post(`${path}/verify`, { code: wrong, last4: "4321" });
    expect(third.statusCode).toBe(429);
    const cooled = (await shareOf(jobId)).cooldownUntil!;
    expect(cooled.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await w.post(`${path}/verify`, { code, last4: "4321" })).statusCode).toBe(429);

    await ctx.db.update(jobShares).set({ cooldownUntil: null }).where(eq(jobShares.id, share.id));
    const ok = await w.post(`${path}/verify`, { code, last4: "4321" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers["set-cookie"]).toMatch(/recap_watch=.*HttpOnly.*SameSite=Lax/i);
    // The code works once.
    expect((await watcher().post(`${path}/verify`, { code, last4: "4321" })).statusCode).toBe(400);

    const page = await w.get(path);
    expect(page.body).toContain("<video");
    expect(page.body).toContain("captions.vtt");
    const ranged = await w.get(`${path}/video.mp4`, { range: "bytes=0-99" });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 0-99/${video.length}`);
    expect(ranged.headers["content-disposition"]).toBe("inline");
    expect(ranged.rawPayload.equals(video.subarray(0, 100))).toBe(true);
    await w.get(`${path}/video.mp4`, { range: "bytes=0-" });
    expect((await w.get(`${path}/video.mp4`, { range: "bytes=999999-" })).statusCode).toBe(416);
    expect((await w.get(`${path}/captions.vtt`)).body).toContain("hello");

    const events = (await ctx.db.select().from(shareEvents).where(eq(shareEvents.shareId, share.id))).map((e) => e.event);
    expect(events.filter((e) => e === "played")).toHaveLength(1);
    // Three wrong answers, then the spent code tried again.
    expect(events.filter((e) => e === "verify_failed")).toHaveLength(4);
    expect(events).toEqual(expect.arrayContaining(["created", "code_sent", "cooldown", "verified"]));
    const after = await shareOf(jobId);
    expect(after.sessionsUsed).toBe(1);
    expect(after.firstViewedAt).not.toBeNull();

    // Timeline for staff carries the client's IP and browser; the never-purged audit log does not.
    const timeline = await staff.get(`/api/jobs/${jobId}/shares`);
    expect(timeline.statusCode).toBe(200);
    const played = timeline.json().events.find((e: { event: string }) => e.event === "played");
    expect(played.ip).toMatch(/^203\.0\.113\./);
    expect(played.userAgent).toBe("Mozilla/5.0 test");
    const auditIps = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action like 'share.%' and actor_label = 'client:share' and ip is not null`);
    expect(Number(auditIps[0]!.n)).toBe(0);
  });

  it("locks after ten failures and stops after five sessions", async () => {
    const jobId = await seedJob();
    await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "three@example.net", requireSecret: false });
    const path = linkPath(ctx.email.last()!.text);
    const share = await shareOf(jobId);
    let last = 0;
    for (let i = 0; i < 10; i++) {
      await ctx.db.update(jobShares).set({ cooldownUntil: null }).where(eq(jobShares.id, share.id));
      last = (await watcher().post(`${path}/verify`, { code: "999999" })).statusCode;
    }
    expect(last).toBe(423);
    expect((await shareOf(jobId)).lockedAt).not.toBeNull();
    expect((await watcher().get(path)).statusCode).toBe(410);
    expect((await watcher().post(`${path}/code`)).statusCode).toBe(410);

    const jobB = await seedJob();
    await admin.post(`/api/jobs/${jobB}/shares`, { channel: "email", contact: "four@example.net", requireSecret: false });
    const pathB = linkPath(ctx.email.last()!.text);
    const shareB = await shareOf(jobB);
    await ctx.db.update(jobShares).set({ sessionsUsed: 5 }).where(eq(jobShares.id, shareB.id));
    expect((await watcher().post(`${pathB}/code`)).statusCode).toBe(410);
    expect((await watcher().get(pathB)).body).toContain("maximum number of times");
  });

  it("share by text message; revoke ends the link; re-issue keeps the contact and the last-4 check", async () => {
    const put = await admin.request("PUT", "/api/settings/sharing", { sms_provider: "twilio", twilio_account_sid: "AC" + "a".repeat(32), twilio_auth_token: "secret-token", twilio_from: "(555) 000-1111" });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().settings.twilio_from).toBe("+15550001111");
    expect(put.json().authTokenMasked).toBe("…oken");
    expect(JSON.stringify(put.json())).not.toContain("secret-token");

    const jobId = await seedJob();
    const res = await admin.post(`/api/jobs/${jobId}/shares`, { channel: "sms", contact: "(555) 222-3333", requireSecret: true, last4: "2468" });
    expect(res.statusCode, res.body).toBe(200);
    const text = ctx.sms.last()!;
    expect(text.to).toBe("+15552223333");
    expect(text.authToken).toBe("secret-token");
    const path = linkPath(text.body);
    const w = watcher();
    expect((await w.post(`${path}/code`)).statusCode).toBe(200);
    expect(ctx.sms.last()!.body).toMatch(/^\d{6} is your Example CPA verification code/);

    const old = await shareOf(jobId);
    expect((await admin.post(`/api/jobs/${jobId}/shares/${old.id}/revoke`)).statusCode).toBe(200);
    expect((await watcher().get(path)).statusCode).toBe(410);

    const re = await admin.post(`/api/jobs/${jobId}/shares/${old.id}/reissue`);
    expect(re.statusCode, re.body).toBe(200);
    const newPath = linkPath(ctx.sms.last()!.body);
    expect(newPath).not.toBe(path);
    expect(ctx.sms.last()!.to).toBe("+15552223333");
    const w2 = watcher();
    await w2.post(`${newPath}/code`);
    const code = lastCode(ctx.sms.last()!.body);
    expect((await w2.post(`${newPath}/verify`, { code, last4: "1111" })).statusCode).toBe(400);
    expect((await w2.post(`${newPath}/verify`, { code, last4: "2468" })).statusCode).toBe(200);
  });

  it("a post from another origin is refused", async () => {
    const jobId = await seedJob();
    await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "five@example.net", requireSecret: false });
    const path = linkPath(ctx.email.last()!.text);
    expect((await watcher().post(`${path}/code`, {}, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await watcher().post(`${path}/code`, {}, { origin: WATCH })).statusCode).toBe(200);
  });

  it("expiry wipes the contact and last 4; a job purge drops the client's IP from the timeline", async () => {
    const jobId = await seedJob();
    await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "six@example.net", requireSecret: true, last4: "1357" });
    const path = linkPath(ctx.email.last()!.text);
    await watcher().post(`${path}/code`);
    const share = await shareOf(jobId);
    await ctx.db.update(jobShares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(jobShares.id, share.id));
    expect(await sweepShares(ctx.app)).toBeGreaterThanOrEqual(1);
    const wiped = await shareOf(jobId);
    expect(wiped.contactWrapped).toBeNull();
    expect(wiped.secretHash).toBeNull();
    expect(wiped.wipedAt).not.toBeNull();
    expect((await watcher().get(path)).statusCode).toBe(410);
    expect((await admin.post(`/api/jobs/${jobId}/shares/${share.id}/reissue`)).statusCode).toBe(400);

    const withIp = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from share_events where job_id = ${jobId} and ip is not null`);
    expect(Number(withIp[0]!.n)).toBeGreaterThan(0);
    await runPurge(ctx.app, { jobId, everything: true });
    const after = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from share_events where job_id = ${jobId} and (ip is not null or user_agent is not null)`);
    expect(Number(after[0]!.n)).toBe(0);
  });

  it("purged video: the link says it is gone", async () => {
    const jobId = await seedJob();
    await admin.post(`/api/jobs/${jobId}/shares`, { channel: "email", contact: "seven@example.net", requireSecret: false });
    const path = linkPath(ctx.email.last()!.text);
    await ctx.db.update(files).set({ purgedAt: new Date() }).where(eq(files.jobId, jobId));
    const page = await watcher().get(path);
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain("no longer available");
  });

  it("the Twilio token is never exported, and share links are masked in logs", async () => {
    const exp = await admin.get("/api/settings/backup/export");
    expect(exp.body).not.toContain("secret-token");
    expect(maskUrl("/watch/abcDEF_-123/video.mp4")).toBe("/watch/[token]/video.mp4");
    expect(maskUrl("/api/jobs/1")).toBe("/api/jobs/1");
  });
});
