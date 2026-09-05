import { promises as fs } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, files, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { orphanCheck, runPurge } from "../src/services/purge.js";

const available = await servicesAvailable();
const DAY = 86400_000;

describe.skipIf(!available)("retention purge", () => {
  let ctx: TestContext;
  let admin: Client;
  let clientId: string;
  let heldClientId: string;
  let userId: string;

  async function seed(status: "released" | "failed" | "needs_review", opts: { client?: string; releasedDaysAgo?: number; readyDaysAgo?: number; failedDaysAgo?: number } = {}): Promise<string> {
    const now = Date.now();
    const [job] = await ctx.db
      .insert(jobs)
      .values({
        status,
        clientId: opts.client ?? clientId,
        uploadedBy: userId,
        sourceSha256: "a".repeat(64),
        taxYear: 2025,
        readyAt: new Date(now - (opts.readyDaysAgo ?? 40) * DAY),
        releasedAt: status === "released" ? new Date(now - (opts.releasedDaysAgo ?? 0) * DAY) : null,
        failedAt: status === "failed" ? new Date(now - (opts.failedDaysAgo ?? 0) * DAY) : null,
      })
      .returning();
    for (const kind of ["source", "extraction", "script", "verification", "video", "vtt", "txt"] as const) {
      const blob = await ctx.storage.put(job!.id, Buffer.from(`${kind}-bytes-${job!.id}`));
      await ctx.db.insert(files).values({ id: blob.id, jobId: job!.id, kind, path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
    }
    return job!.id;
  }

  async function liveKinds(jobId: string): Promise<string[]> {
    const rows = await ctx.db.select().from(files).where(eq(files.jobId, jobId));
    return rows.filter((f) => !f.purgedAt).map((f) => f.kind).sort();
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    userId = me.user.id;
    const [c] = await ctx.db.insert(clients).values({ name: "Fixture, Alex", normalizedName: "fixture, alex" }).returning();
    clientId = c!.id;
    const [h] = await ctx.db.insert(clients).values({ name: "Held, Client", normalizedName: "held, client", legalHold: true }).returning();
    heldClientId = h!.id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("purges exactly at the window edge, not before (time travel)", async () => {
    // defaults: source 30 d after ready; extraction 365 d and video 90 d after release
    const jobId = await seed("released", { readyDaysAgo: 0, releasedDaysAgo: 0 });
    const t0 = Date.now();
    const before = await runPurge(ctx.app, { now: new Date(t0 + 30 * DAY - 60_000) });
    expect(before.candidates.filter((c) => c.job.id === jobId)).toHaveLength(0);
    const atEdge = await runPurge(ctx.app, { now: new Date(t0 + 30 * DAY + 60_000) });
    expect(atEdge.candidates.filter((c) => c.job.id === jobId).map((c) => c.file.kind)).toEqual(["source"]);
    expect(await liveKinds(jobId)).toEqual(["extraction", "script", "txt", "verification", "video", "vtt"]);
    const v = await runPurge(ctx.app, { now: new Date(t0 + 90 * DAY + 60_000) });
    expect(v.candidates.filter((c) => c.job.id === jobId).map((c) => c.file.kind).sort()).toEqual(["txt", "video", "vtt"]);
    const e = await runPurge(ctx.app, { now: new Date(t0 + 365 * DAY + 60_000) });
    expect(e.candidates.filter((c) => c.job.id === jobId).map((c) => c.file.kind).sort()).toEqual(["extraction", "script", "verification"]);
    expect(e.purgedJobs).toBeGreaterThanOrEqual(1);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("purged");
    expect(job!.purgedAt).not.toBeNull();
    const audits = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'file.purge' and target_id = ${jobId} and actor_label = 'system:retention'`);
    expect(Number(audits[0]!.n)).toBe(7);
    // the shredded blob is gone from disk
    const [f] = await ctx.db.select().from(files).where(eq(files.jobId, jobId)).limit(1);
    await expect(fs.access(ctx.storage.abs(f!.path))).rejects.toThrow();
  });

  it("source retention 0 removes the PDF on the first run after ready", async () => {
    const res = await admin.request("PUT", "/api/settings/retention", { retention_source_days: 0 });
    expect(res.statusCode).toBe(200);
    const jobId = await seed("needs_review", { readyDaysAgo: 0 });
    const r = await runPurge(ctx.app, { now: new Date(Date.now() + 1000) });
    expect(r.candidates.filter((c) => c.job.id === jobId).map((c) => c.file.kind)).toEqual(["source"]);
    expect(await liveKinds(jobId)).not.toContain("source");
    await admin.request("PUT", "/api/settings/retention", { retention_source_days: 30 });
  });

  it("failed jobs are purged whole after the failed window", async () => {
    const jobId = await seed("failed", { failedDaysAgo: 8 });
    const r = await runPurge(ctx.app);
    expect(r.candidates.filter((c) => c.job.id === jobId)).toHaveLength(7);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("purged");
  });

  it("legal hold blocks purge; clearing it purges on the next run", async () => {
    const jobId = await seed("failed", { client: heldClientId, failedDaysAgo: 30 });
    const held = await runPurge(ctx.app);
    expect(held.candidates.filter((c) => c.job.id === jobId)).toHaveLength(0);
    expect(held.skippedLegalHold).toBeGreaterThanOrEqual(7);
    await admin.request("PATCH", `/api/clients/${heldClientId}`, { legalHold: false });
    const after = await runPurge(ctx.app);
    expect(after.candidates.filter((c) => c.job.id === jobId)).toHaveLength(7);
  });

  it("client purge-now needs the exact name and refuses on legal hold", async () => {
    const [c] = await ctx.db.insert(clients).values({ name: "Gone, Soon", normalizedName: "gone, soon" }).returning();
    const jobId = await seed("released", { client: c!.id });
    const wrong = await admin.post(`/api/clients/${c!.id}/purge-now`, { confirmName: "Gone" });
    expect(wrong.statusCode).toBe(400);
    const ok = await admin.post(`/api/clients/${c!.id}/purge-now`, { confirmName: "Gone, Soon" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().purgedFiles).toBe(7);
    expect(await liveKinds(jobId)).toEqual([]);
    const held = await admin.post(`/api/clients/${heldClientId}/purge-now`, { confirmName: "Held, Client" });
    // hold was cleared in the previous test; set it again and check the refusal
    await admin.request("PATCH", `/api/clients/${heldClientId}`, { legalHold: true });
    const refused = await admin.post(`/api/clients/${heldClientId}/purge-now`, { confirmName: "Held, Client" });
    expect(refused.statusCode).toBe(400);
    expect([200, 400]).toContain(held.statusCode);
  });

  it("purge-now preview is a dry run; report lists due counts; non-admins are refused", async () => {
    await ctx.db.insert(users).values({ email: "prep@example.com", name: "P", role: "preparer", passwordHash: await hashPassword("preparer-password-long") });
    const prep = new Client(ctx.app);
    await prep.login("prep@example.com", "preparer-password-long");
    expect((await prep.get("/api/settings/retention")).statusCode).toBe(403);
    await seed("failed", { failedDaysAgo: 9 });
    const preview = await admin.post("/api/settings/retention/purge-now", {});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().dryRun).toBe(true);
    expect(preview.json().preview.length).toBeGreaterThanOrEqual(7);
    const report = await admin.get("/api/settings/retention");
    expect(report.json().report.dueNow).toBeGreaterThanOrEqual(7);
    const csv = await admin.get("/api/settings/retention/report.csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split("\n")[0]).toBe("job_id,client_id,kind,file_sha256,reason");
    const run = await admin.post("/api/settings/retention/purge-now", { confirm: true });
    expect(run.json().dryRun).toBe(false);
    expect(run.json().purgedFiles).toBeGreaterThanOrEqual(7);
  });

  it("orphan blobs are quarantined, never deleted", async () => {
    const stray = await ctx.storage.put("stray-job", Buffer.from("no db row for me"));
    const { moved } = await orphanCheck(ctx.app);
    expect(moved).toBe(1);
    await expect(fs.access(ctx.storage.abs(stray.path))).rejects.toThrow();
    const quarantined = await fs.readdir(path.join(ctx.dataDir, "orphans"));
    expect(quarantined.some((n) => n.endsWith(".age"))).toBe(true);
  });
});
