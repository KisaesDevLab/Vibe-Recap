import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, files, jobFeedback, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { runPurge } from "../src/services/purge.js";
import { setSetting } from "../src/services/settings.js";

const available = await servicesAvailable();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures");

describe.skipIf(!available)("feedback and the retention hold", () => {
  let ctx: TestContext;
  let admin: Client;
  let staff: Client;
  let jobId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    await ctx.db.insert(users).values({ email: "staff@example.com", name: "S", role: "staff", passwordHash: await hashPassword("staff-password-long") });
    staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    const [client] = await ctx.db.insert(clients).values({ name: "Fixture, Alex & Jordan", normalizedName: "fixture, alex & jordan" }).returning();
    const failedAt = new Date(Date.now() - 30 * 86400_000); // well past the 7-day failed-job window
    const [job] = await ctx.db
      .insert(jobs)
      .values({ status: "failed", step: "extract", errorStep: "extract", errorMessage: "required lines missing", clientId: client!.id, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025, software: "ultratax", failedAt, createdAt: failedAt })
      .returning();
    jobId = job!.id;
    const pdf = await fs.readFile(path.join(FIXTURES, "ultratax-1040-2025-mfj-refund-mo.pdf"));
    const blob = await ctx.storage.put(jobId, pdf);
    await ctx.db.insert(files).values({ id: blob.id, jobId, kind: "source", path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
    const ex = await ctx.storage.put(jobId, Buffer.from(JSON.stringify({ meta: { software: "ultratax" } })));
    await ctx.db.insert(files).values({ id: ex.id, jobId, kind: "extraction", path: ex.path, keyPath: ex.keyPath, sha256: ex.sha256, size: ex.size });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("validates a thumbs-down, records it once per user, audits it, and holds the job's files", async () => {
    const noReason = await staff.post(`/api/jobs/${jobId}/feedback`, { verdict: "down", reasons: [] });
    expect(noReason.statusCode).toBe(400);
    const badReason = await staff.post(`/api/jobs/${jobId}/feedback`, { verdict: "down", reasons: ["made_up"] });
    expect(badReason.statusCode).toBe(400);
    const otherNoNote = await staff.post(`/api/jobs/${jobId}/feedback`, { verdict: "down", reasons: ["other"] });
    expect(otherNoNote.statusCode).toBe(400);
    const res = await staff.post(`/api/jobs/${jobId}/feedback`, { verdict: "down", reasons: ["extraction_failed", "wrong_number"], note: "line 9 missing" });
    expect(res.statusCode, res.body).toBe(201);
    const fb = res.json();
    expect(fb.verdict).toBe("down");
    expect(fb.reasons).toEqual(["extraction_failed", "wrong_number"]);
    expect(new Date(fb.holdUntil).getTime()).toBeGreaterThan(Date.now() + 89 * 86400_000);

    // the same user again replaces, never duplicates
    const again = await staff.post(`/api/jobs/${jobId}/feedback`, { verdict: "down", reasons: ["wording"] });
    expect(again.statusCode).toBe(201);
    const rows = await ctx.db.select().from(jobFeedback).where(eq(jobFeedback.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reasons).toEqual(["wording"]);
    const audits = await ctx.db.execute<{ action: string }>(sql`select action from audit_events where target_id = ${jobId} and action = 'job.feedback'`);
    expect(audits.length).toBe(2);

    // the failed job is 30 days old with a 7-day window: due, but held
    await setSetting(ctx.db, "retention_failed_days", 7, null);
    const dry = await runPurge(ctx.app, { dryRun: true });
    expect(dry.candidates.filter((c) => c.job.id === jobId)).toHaveLength(0);
    expect(dry.skippedFeedbackHold).toBe(2);
    const live = await ctx.db.select().from(files).where(eq(files.jobId, jobId));
    expect(live.every((f) => !f.purgedAt)).toBe(true);
  });

  it("admins see the open case with counts, can download a bundle, and dismissing releases the hold", async () => {
    expect((await staff.get("/api/feedback")).statusCode).toBe(403);
    const list = await admin.get("/api/feedback");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.stats.down).toBe(1);
    expect(body.stats.up).toBe(0);
    expect(body.stats.byReason).toEqual({ wording: 1 });
    expect(body.stats.openHolds).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].jobId).toBe(jobId);
    expect(body.rows[0].filesPurged).toBe(false);

    const bundle = await admin.get(`/api/feedback/${body.rows[0].id}/bundle.zip`);
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers["content-type"]).toBe("application/zip");
    const zip = bundle.rawPayload;
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    const text = zip.toString("latin1");
    expect(text).toContain("manifest.json");
    expect(text).toContain("extraction.json");
    expect(text).toContain("source.pdf");
    const audits = await ctx.db.execute<{ action: string }>(sql`select action from audit_events where target_id = ${jobId} and action = 'feedback.bundle'`);
    expect(audits.length).toBe(1);

    expect((await staff.post(`/api/feedback/${body.rows[0].id}/dismiss`, {})).statusCode).toBe(403);
    const dismissed = await admin.post(`/api/feedback/${body.rows[0].id}/dismiss`, {});
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().dismissedBy).toBeTruthy();
    const after = await admin.get("/api/feedback");
    expect(after.json().rows).toHaveLength(0);
    expect(after.json().stats.openHolds).toBe(0);
    const all = await admin.get("/api/feedback?scope=all");
    expect(all.json().rows).toHaveLength(1);

    // with the hold released the failed job's files are due
    const dry = await runPurge(ctx.app, { dryRun: true });
    expect(dry.candidates.filter((c) => c.job.id === jobId)).toHaveLength(2);
    expect(dry.skippedFeedbackHold).toBe(0);
  });

  it("thumbs up carries no hold and is refused on a job that is still processing", async () => {
    const up = await admin.post(`/api/jobs/${jobId}/feedback`, { verdict: "up" });
    expect(up.statusCode).toBe(201);
    expect(up.json().holdUntil).toBeNull();
    await ctx.db.update(jobs).set({ status: "processing" }).where(eq(jobs.id, jobId));
    const busy = await admin.post(`/api/jobs/${jobId}/feedback`, { verdict: "up" });
    expect(busy.statusCode).toBe(400);
    await ctx.db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, jobId));
    const stats = (await admin.get("/api/feedback?scope=all")).json().stats;
    expect(stats.up).toBe(1);
    expect(stats.down).toBe(1);
  });
});
