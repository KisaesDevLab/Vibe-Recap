import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, files, jobRevisions, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";

const available = await servicesAvailable();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures");

describe.skipIf(!available)("revision requests", () => {
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
    const golden = await fs.readFile(path.join(FIXTURES, "scripts", "mfj-refund-mo.md"));
    const [job] = await ctx.db
      .insert(jobs)
      .values({ status: "needs_review", step: "ready", clientId: client!.id, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025 })
      .returning();
    jobId = job!.id;
    const blob = await ctx.storage.put(jobId, golden);
    await ctx.db.insert(files).values({ id: blob.id, jobId, kind: "script", path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
    await ctx.db.update(jobs).set({ scriptSha256: blob.sha256 }).where(eq(jobs.id, jobId));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("preparers can request a revision; it is recorded, audited, and the job is re-queued from script", async () => {
    expect((await staff.post(`/api/jobs/${jobId}/revisions`, { message: "warmer tone" })).statusCode).toBe(403);
    const res = await admin.post(`/api/jobs/${jobId}/revisions`, { message: "Warmer tone, and mention the estimated payments earlier." });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe("pending");
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("queued");
    expect(job!.resumeFrom).toBe("script");
    const [rev] = await ctx.db.select().from(jobRevisions).where(eq(jobRevisions.jobId, jobId));
    expect(rev!.previousStatus).toBe("needs_review");
    expect(rev!.scriptSha256Before).toBe(job!.scriptSha256);
    const audits = await ctx.db.execute<{ action: string }>(sql`select action from audit_events where target_id = ${jobId} order by id`);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["job.revision_request", "job.regenerate"]));
    const list = await staff.get(`/api/jobs/${jobId}/revisions`);
    expect(list.json().revisions).toHaveLength(1);
  });

  it("refuses a second request while one is pending and while the job is processing", async () => {
    const again = await admin.post(`/api/jobs/${jobId}/revisions`, { message: "another change" });
    expect(again.statusCode).toBe(400);
    await ctx.db.update(jobRevisions).set({ status: "applied" }).where(eq(jobRevisions.jobId, jobId));
    const busy = await admin.post(`/api/jobs/${jobId}/revisions`, { message: "another change" });
    expect(busy.statusCode).toBe(400); // job is queued
    await ctx.db.update(jobs).set({ status: "needs_review" }).where(eq(jobs.id, jobId));
    const ok = await admin.post(`/api/jobs/${jobId}/revisions`, { message: "another change" });
    expect(ok.statusCode).toBe(201);
  });
});
