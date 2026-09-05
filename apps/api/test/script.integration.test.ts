import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, files, jobs } from "../src/db/schema.js";

const available = await servicesAvailable();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures");

describe.skipIf(!available)("script editing, regeneration, verification", () => {
  let ctx: TestContext;
  let admin: Client;
  let jobId: string;
  let golden: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    const [client] = await ctx.db.insert(clients).values({ name: "Fixture, Alex & Jordan", normalizedName: "fixture, alex & jordan" }).returning();
    const extraction = await fs.readFile(path.join(FIXTURES, "ultratax-1040-2025-mfj-refund-mo.expected.json"));
    golden = await fs.readFile(path.join(FIXTURES, "scripts", "mfj-refund-mo.md"), "utf8");
    const pdf = await fs.readFile(path.join(FIXTURES, "ultratax-1040-2025-mfj-refund-mo.pdf"));
    const [job] = await ctx.db
      .insert(jobs)
      .values({ status: "needs_review", step: "ready", clientId: client!.id, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025, software: "ultratax" })
      .returning();
    jobId = job!.id;
    for (const [kind, data] of [["source", pdf], ["extraction", extraction], ["script", Buffer.from(golden)]] as const) {
      const blob = await ctx.storage.put(jobId, data);
      await ctx.db.insert(files).values({ id: blob.id, jobId, kind, path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
      if (kind === "extraction") await ctx.db.update(jobs).set({ extractionSha256: blob.sha256 }).where(eq(jobs.id, jobId));
      if (kind === "script") await ctx.db.update(jobs).set({ scriptSha256: blob.sha256 }).where(eq(jobs.id, jobId));
    }
    const verification = { passed: true, items: [{ kind: "amount", text: "$153,800", status: "verified", page: 1, label: "total income" }], source_sha256: "x", script_sha256: "not-the-current-script" };
    const vb = await ctx.storage.put(jobId, Buffer.from(JSON.stringify(verification)));
    await ctx.db.insert(files).values({ id: vb.id, jobId, kind: "verification", path: vb.path, keyPath: vb.keyPath, sha256: vb.sha256, size: vb.size });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("returns the stored script with hashes", async () => {
    const res = await admin.get(`/api/jobs/${jobId}/script`);
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toContain("[[slide:greeting]]");
    expect(res.json().extractionSha256).toHaveLength(64);
  });

  it("rejects a manual edit that introduces a number not in the extraction, in the API", async () => {
    const res = await admin.request("PUT", `/api/jobs/${jobId}/script`, { script: golden.replace("$153,800", "$1,234") });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.errors.join(" ")).toContain("$1,234");
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("needs_review"); // untouched
  });

  it("reports a stale verification when the script hash differs", async () => {
    const res = await admin.get(`/api/jobs/${jobId}/verification`);
    expect(res.statusCode).toBe(200);
    expect(res.json().stale).toBe(true);
    expect(res.json().verification.items).toHaveLength(1);
  });

  it("accepts a valid edit, stores it, audits, and re-queues from validate", async () => {
    const edited = golden.replace("In the next couple of minutes", "In the next few minutes");
    const res = await admin.request("PUT", `/api/jobs/${jobId}/script`, { script: edited });
    expect(res.statusCode, res.body).toBe(200);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("queued");
    expect(job!.resumeFrom).toBe("validate");
    expect(job!.scriptSha256).toBe(res.json().sha256);
    const stored = await admin.get(`/api/jobs/${jobId}/script`);
    expect(stored.json().script).toContain("In the next few minutes");
    const audits = await ctx.db.execute<{ action: string }>(sql`select action from audit_events where target_id = ${jobId} order by id`);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["job.script_edit", "job.rerender"]));
  });

  it("regenerate requeues from script only when editable", async () => {
    const busy = await admin.post(`/api/jobs/${jobId}/regenerate`);
    expect(busy.statusCode).toBe(400); // queued from the previous test
    await ctx.db.update(jobs).set({ status: "rejected" }).where(eq(jobs.id, jobId));
    const ok = await admin.post(`/api/jobs/${jobId}/regenerate`);
    expect(ok.statusCode).toBe(200);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.resumeFrom).toBe("script");
  });

  it("serves the source PDF to preparers and audits the read", async () => {
    const res = await admin.get(`/api/jobs/${jobId}/source.pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const audits = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'file.read' and target_id = ${jobId}`);
    expect(Number(audits[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});
