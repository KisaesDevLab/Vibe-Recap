import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, files, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";

const available = await servicesAvailable();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures");

describe.skipIf(!available)("extraction, recon exceptions, re-extract", () => {
  let ctx: TestContext;
  let admin: Client;
  let jobId: string;
  let expected: Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    const [client] = await ctx.db.insert(clients).values({ name: "Fixture, Alex & Jordan", normalizedName: "fixture, alex & jordan" }).returning();
    // Simulate a job the worker failed at recon, with its extraction.json stored.
    expected = JSON.parse(await fs.readFile(path.join(FIXTURES, "ultratax-1040-2025-mfj-refund-mo.expected.json"), "utf8"));
    const doc = JSON.parse(JSON.stringify(expected)) as { recon: { passed: boolean; checks: Array<{ name: string; ok: boolean; expected: number; actual: number }> } };
    doc.recon.passed = false;
    doc.recon.checks[0]!.ok = false;
    doc.recon.checks[0]!.actual += 500;
    const [job] = await ctx.db
      .insert(jobs)
      .values({ status: "failed", step: "recon", errorStep: "recon", errorMessage: "reconciliation failed: total_income_foots", clientId: client!.id, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025, software: "ultratax" })
      .returning();
    jobId = job!.id;
    const blob = await ctx.storage.put(jobId, Buffer.from(JSON.stringify(doc)));
    await ctx.db.insert(files).values({ id: blob.id, jobId, kind: "extraction", path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("returns the extraction JSON read-only and audits the read", async () => {
    const res = await admin.get(`/api/jobs/${jobId}/extraction`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.extraction.meta.tax_year).toBe(2025);
    expect(body.extraction.income.total_income).toBe((expected as { income: { total_income: number } }).income.total_income);
    expect(body.extraction.recon.passed).toBe(false);
    expect(body.sha256).toHaveLength(64);
    expect(body.reconExceptions).toEqual([]);
    const reads = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'file.read' and target_id = ${jobId}`);
    expect(Number(reads[0]!.n)).toBe(1);
  });

  it("refuses an exception without a 20-character reason and from a non-preparer", async () => {
    const short = await admin.post(`/api/jobs/${jobId}/recon-exceptions`, { check: "total_income_foots", reason: "too short" });
    expect(short.statusCode).toBe(400);
    const unknown = await admin.post(`/api/jobs/${jobId}/recon-exceptions`, { check: "nope_foots", reason: "this reason is definitely long enough" });
    expect(unknown.statusCode).toBe(404);
    await ctx.db.insert(users).values({ email: "staff@example.com", name: "S", role: "staff", passwordHash: await hashPassword("staff-password-long") });
    const staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    const forbidden = await staff.post(`/api/jobs/${jobId}/recon-exceptions`, { check: "total_income_foots", reason: "this reason is definitely long enough" });
    expect(forbidden.statusCode).toBe(403);
  });

  it("records a per-job exception, audits it, and re-queues from recon", async () => {
    const res = await admin.post(`/api/jobs/${jobId}/recon-exceptions`, { check: "total_income_foots", reason: "W-2 box 1 differs from wage statement; confirmed with client" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().reconExceptions).toHaveLength(1);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("queued");
    expect(job!.resumeFrom).toBe("recon");
    expect(job!.reconExceptions[0]!.check).toBe("total_income_foots");
    expect(job!.reconExceptions[0]!.by).toBe("admin@example.com");
    const audits = await ctx.db.execute<{ action: string }>(sql`select action from audit_events where target_id = ${jobId} order by id`);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("job.recon_exception");
    expect(actions).toContain("job.retry");
    const again = await admin.post(`/api/jobs/${jobId}/recon-exceptions`, { check: "total_income_foots", reason: "this reason is definitely long enough" });
    expect(again.statusCode).toBe(400); // already downgraded, and no longer failed at recon
  });

  it("re-extract re-queues from identify and refuses while queued", async () => {
    const busy = await admin.post(`/api/jobs/${jobId}/re-extract`);
    expect(busy.statusCode).toBe(400);
    await ctx.db.update(jobs).set({ status: "needs_review" }).where(eq(jobs.id, jobId));
    const ok = await admin.post(`/api/jobs/${jobId}/re-extract`);
    expect(ok.statusCode).toBe(200);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("queued");
    expect(job!.resumeFrom).toBe("identify");
  });
});
