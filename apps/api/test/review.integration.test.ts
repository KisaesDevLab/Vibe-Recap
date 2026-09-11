import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { batches, clients, files, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";

const available = await servicesAvailable();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!available)("approval gating, reject, re-render, bulk approve", () => {
  let ctx: TestContext;
  let admin: Client;
  let staff: Client;
  let viewer: Client;
  let batchId: string;
  let goodJob: string;
  let staleJob: string;
  let flaggedJob: string;
  let exceptionJob: string;
  let golden: string;
  let extraction: Buffer;

  async function seedJob(opts: { verification: object; scriptHashMatches?: boolean; withVideo?: boolean; reconExceptions?: unknown[] }): Promise<string> {
    const [client] = await ctx.db.select().from(clients).limit(1);
    const me = (await admin.get("/api/auth/me")).json();
    const [job] = await ctx.db
      .insert(jobs)
      .values({ status: "needs_review", step: "ready", clientId: client!.id, batchId, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025, software: "ultratax", reconExceptions: (opts.reconExceptions ?? []) as never })
      .returning();
    const id = job!.id;
    const put = async (kind: "source" | "extraction" | "script" | "verification" | "video" | "vtt" | "txt", data: Buffer) => {
      const blob = await ctx.storage.put(id, data);
      await ctx.db.insert(files).values({ id: blob.id, jobId: id, kind, path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
      return blob.sha256;
    };
    const exSha = await put("extraction", extraction);
    const scriptSha = await put("script", Buffer.from(golden));
    await put("verification", Buffer.from(JSON.stringify(opts.verification)));
    if (opts.withVideo !== false) {
      await put("video", Buffer.from("\x00\x00\x00\x18ftypmp42fake-video"));
      await put("vtt", Buffer.from("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhi\n"));
      await put("txt", Buffer.from("hi\n"));
    }
    await ctx.db.update(jobs).set({ extractionSha256: exSha, scriptSha256: opts.scriptHashMatches === false ? "f".repeat(64) : scriptSha }).where(eq(jobs.id, id));
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    await ctx.db.insert(clients).values({ name: "Fixture, Alex & Jordan", normalizedName: "fixture, alex & jordan" });
    await ctx.db.insert(users).values([
      { email: "staff@example.com", name: "S", role: "staff", passwordHash: await hashPassword("staff-password-long") },
      { email: "viewer@example.com", name: "V", role: "viewer", passwordHash: await hashPassword("viewer-password-long") },
    ]);
    staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    viewer = new Client(ctx.app);
    await viewer.login("viewer@example.com", "viewer-password-long");
    const [batch] = await ctx.db.insert(batches).values({ uploadedBy: me.user.id, fileCount: 4 }).returning();
    batchId = batch!.id;
    golden = await fs.readFile(path.join(FIXTURES, "scripts", "mfj-refund-mo.md"), "utf8");
    extraction = await fs.readFile(path.join(FIXTURES, "ultratax-1040-2025-mfj-refund-mo.expected.json"));
    const okVer = { passed: true, items: [{ kind: "amount", text: "$153,800", status: "verified", page: 1, label: "total income" }], source_sha256: "s", script_sha256: sha(golden) };
    goodJob = await seedJob({ verification: okVer });
    staleJob = await seedJob({ verification: { ...okVer, script_sha256: "0".repeat(64) } });
    flaggedJob = await seedJob({ verification: { ...okVer, passed: false, items: [{ kind: "amount", text: "$9", status: "flagged", reason: "nope" }] } });
    exceptionJob = await seedJob({ verification: okVer, reconExceptions: [{ check: "total_income_foots", reason: "documented mismatch on the W-2", by: "admin@example.com", at: "2026-09-05" }] });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("refuses approve for staff and viewer roles", async () => {
    expect((await staff.post(`/api/jobs/${goodJob}/approve`)).statusCode).toBe(403);
    expect((await viewer.post(`/api/jobs/${goodJob}/approve`)).statusCode).toBe(403);
  });

  it("refuses approve when verification is stale or flagged, or the script hash differs", async () => {
    const stale = await admin.post(`/api/jobs/${staleJob}/approve`);
    expect(stale.statusCode).toBe(400);
    expect(stale.json().message).toMatch(/stale/);
    const flagged = await admin.post(`/api/jobs/${flaggedJob}/approve`);
    expect(flagged.statusCode).toBe(400);
    expect(flagged.json().message).toMatch(/flagged/);
    await ctx.db.update(jobs).set({ scriptSha256: "e".repeat(64) }).where(eq(jobs.id, goodJob));
    const mismatch = await admin.post(`/api/jobs/${goodJob}/approve`);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().message).toMatch(/script hash/);
    await ctx.db.update(jobs).set({ scriptSha256: sha(golden) }).where(eq(jobs.id, goodJob));
    const missing = await seedJob({ verification: { passed: true, items: [], source_sha256: "s", script_sha256: sha(golden) } });
    await ctx.db.delete(files).where(sql`${files.jobId} = ${missing} and ${files.kind} = 'verification'`);
    const noVer = await admin.post(`/api/jobs/${missing}/approve`);
    expect(noVer.statusCode).toBe(400);
    expect(noVer.json().message).toMatch(/missing/);
  });

  it("approval endpoint reports readiness and staff/viewer cannot see the video until approved/released", async () => {
    expect((await admin.get(`/api/jobs/${goodJob}/approval`)).json()).toEqual({ ok: true });
    expect((await admin.get(`/api/jobs/${flaggedJob}/approval`)).json().ok).toBe(false);
    expect((await staff.get(`/api/jobs/${goodJob}/preview.mp4`)).statusCode).toBe(403);
    expect((await admin.get(`/api/jobs/${goodJob}/preview.mp4`)).statusCode).toBe(200);
  });

  it("approves with a three-hash snapshot and an audit row", async () => {
    const res = await admin.post(`/api/jobs/${goodJob}/approve`);
    expect(res.statusCode, res.body).toBe(200);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, goodJob));
    expect(job!.status).toBe("approved");
    expect(job!.approvedScriptSha256).toBe(sha(golden));
    expect(job!.approvedExtractionSha256).toBe(job!.extractionSha256);
    expect(job!.approvedVerificationSha256).toHaveLength(64);
    const rows = await ctx.db.execute<{ meta: Record<string, unknown> }>(sql`select meta from audit_events where action = 'job.approve' and target_id = ${goodJob}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta.bulk).toBeUndefined();
    // staff can now preview, viewer still cannot (not released)
    expect((await staff.get(`/api/jobs/${goodJob}/preview.mp4`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/jobs/${goodJob}/preview.mp4`)).statusCode).toBe(403);
    // ranged video request works
    const ranged = await admin.request("GET", `/api/jobs/${goodJob}/preview.mp4`, undefined, { range: "bytes=0-3" });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toMatch(/^bytes 0-3\//);
  });

  it("reject records the reason and re-render resumes at tts when verification still matches", async () => {
    const rej = await admin.post(`/api/jobs/${goodJob}/reject`, { reason: "Tone is too casual for this client" });
    expect(rej.statusCode).toBe(200);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, goodJob));
    expect(job!.status).toBe("rejected");
    expect(job!.rejectedReason).toMatch(/too casual/);
    const rr = await admin.post(`/api/jobs/${goodJob}/rerender`);
    expect(rr.statusCode).toBe(200);
    expect(rr.json().resumeFrom).toBe("tts");
    const [after] = await ctx.db.select().from(jobs).where(eq(jobs.id, goodJob));
    expect(after!.status).toBe("queued");
    const rr2 = await admin.post(`/api/jobs/${staleJob}/rerender`);
    expect(rr2.json().resumeFrom).toBe("validate"); // stale verification: must re-verify first
  });

  it("re-render can change this job's narration voice, and the voice sticks to the job", async () => {
    const jobId = await seedJob({ verification: { passed: true, items: [], source_sha256: "s", script_sha256: sha(golden) } });
    await admin.post(`/api/jobs/${jobId}/reject`, { reason: "Client asked for a male narrator" });

    const bad = await admin.post(`/api/jobs/${jobId}/rerender`, { voice: "not_a_voice" });
    expect(bad.statusCode).toBe(400);

    const rr = await admin.post(`/api/jobs/${jobId}/rerender`, { voice: "am_fenrir" });
    expect(rr.statusCode, rr.body).toBe(200);
    expect(rr.json().voice).toBe("am_fenrir");
    const [withVoice] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(withVoice!.voice).toBe("am_fenrir");

    // a later re-render without a voice keeps the one already on the job
    await ctx.db.update(jobs).set({ status: "needs_review" }).where(eq(jobs.id, jobId));
    const again = await admin.post(`/api/jobs/${jobId}/rerender`);
    expect(again.json().voice).toBe("am_fenrir");

    // and null clears it, back to the uploader's own voice then the firm default
    await ctx.db.update(jobs).set({ status: "needs_review" }).where(eq(jobs.id, jobId));
    const cleared = await admin.post(`/api/jobs/${jobId}/rerender`, { voice: null });
    expect(cleared.json().voice).toBe(null);
    const [after] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(after!.voice).toBe(null);
  });

  it("bulk approve takes only clean jobs, skips exceptions and flags, one audit row each with bulk:true", async () => {
    const clean1 = await seedJob({ verification: { passed: true, items: [], source_sha256: "s", script_sha256: sha(golden) } });
    const clean2 = await seedJob({ verification: { passed: true, items: [], source_sha256: "s", script_sha256: sha(golden) } });
    const res = await admin.post(`/api/batches/${batchId}/approve-verified`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { approved: string[]; skipped: Array<{ id: string; reason: string }> };
    expect(body.approved.sort()).toEqual([clean1, clean2].sort());
    const skippedIds = body.skipped.map((s) => s.id);
    expect(skippedIds).toContain(flaggedJob);
    expect(skippedIds).toContain(exceptionJob);
    expect(body.skipped.find((s) => s.id === exceptionJob)!.reason).toMatch(/exception/);
    const rows = await ctx.db.execute<{ target_id: string; meta: Record<string, unknown> }>(sql`select target_id, meta from audit_events where action = 'job.approve' and (meta->>'bulk') = 'true'`);
    expect(rows.map((r) => r.target_id).sort()).toEqual([clean1, clean2].sort());
    const denied = await staff.post(`/api/batches/${batchId}/approve-verified`);
    expect(denied.statusCode).toBe(403);
  });
});
