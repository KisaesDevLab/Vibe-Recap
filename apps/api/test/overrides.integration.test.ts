import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, extractionOverrides, files, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";
import { runPurge } from "../src/services/purge.js";

const available = await servicesAvailable();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures");
const REASON = "Line 3b misread as zero; 746 on the return, profile fix pending";

describe.skipIf(!available)("extraction overrides (Q66)", () => {
  let ctx: TestContext;
  let admin: Client;
  let jobId: string;
  let extractedDividends: number;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    const [client] = await ctx.db.insert(clients).values({ name: "Fixture, Alex & Jordan", normalizedName: "fixture, alex & jordan" }).returning();
    const doc = JSON.parse(await fs.readFile(path.join(FIXTURES, "ultratax-1040-2025-mfj-refund-mo.expected.json"), "utf8"));
    doc.meta.profile = "1040-2025-ultratax.yaml";
    doc.evidence = { "income.dividends": [{ page: 13, line: "3b", label: "Ordinary dividends", y: 577.2 }] };
    doc.overrides = [];
    extractedDividends = doc.income.dividends;
    const [job] = await ctx.db
      .insert(jobs)
      .values({ status: "failed", step: "recon", errorStep: "recon", errorMessage: "reconciliation failed", clientId: client!.id, uploadedBy: me.user.id, sourceSha256: "b".repeat(64), taxYear: 2025, software: "ultratax" })
      .returning();
    jobId = job!.id;
    const blob = await ctx.storage.put(jobId, Buffer.from(JSON.stringify(doc)));
    await ctx.db.insert(files).values({ id: blob.id, jobId, kind: "extraction", path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const setStatus = (status: "failed" | "needs_review" | "released") => ctx.db.update(jobs).set({ status }).where(eq(jobs.id, jobId));

  it("refuses a short reason, an unknown field, a duplicate field, and a staff user", async () => {
    const url = `/api/jobs/${jobId}/extraction-overrides`;
    expect((await admin.post(url, { overrides: [{ path: "income.dividends", value: 746 }], reason: "too short" })).statusCode).toBe(400);
    expect((await admin.post(url, { overrides: [{ path: "meta.filing_status", value: 1 }], reason: REASON })).statusCode).toBe(400);
    expect((await admin.post(url, { overrides: [{ path: "tax.effective_rate", value: 1 }], reason: REASON })).statusCode).toBe(400);
    expect((await admin.post(url, { overrides: [{ path: "income.dividends", value: 1.5 }], reason: REASON })).statusCode).toBe(400);
    const dup = await admin.post(url, { overrides: [{ path: "income.dividends", value: 1 }, { path: "income.dividends", value: 2 }], reason: REASON });
    expect(dup.statusCode).toBe(400);
    await ctx.db.insert(users).values({ email: "staff@example.com", name: "S", role: "staff", passwordHash: await hashPassword("staff-password-long") });
    const staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    expect((await staff.post(url, { overrides: [{ path: "income.dividends", value: 746 }], reason: REASON })).statusCode).toBe(403);
    const rows = await ctx.db.select().from(extractionOverrides);
    expect(rows).toHaveLength(0);
  });

  it("logs the override with what the mapper read and where, audits it without amounts, and re-runs from extract", async () => {
    const res = await admin.post(`/api/jobs/${jobId}/extraction-overrides`, {
      overrides: [
        { path: "income.dividends", value: 746 },
        { path: "state.MO.refund", value: 1320 },
      ],
      reason: REASON,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().overrides).toHaveLength(2);
    const [row] = await ctx.db.select().from(extractionOverrides).where(eq(extractionOverrides.path, "income.dividends"));
    expect(row!.value).toBe(746);
    expect(row!.extractedValue).toBe(extractedDividends);
    expect(row!.evidence).toEqual([{ page: 13, line: "3b", label: "Ordinary dividends", y: 577.2 }]);
    expect(row!.profile).toBe("1040-2025-ultratax.yaml");
    expect(row!.software).toBe("ultratax");
    expect(row!.createdByLabel).toBe("admin@example.com");
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("queued");
    expect(job!.resumeFrom).toBe("extract");
    const audits = await ctx.db.execute<{ action: string; meta: Record<string, unknown> }>(
      sql`select action, meta from audit_events where target_id = ${jobId} and action = 'job.extraction_override'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.meta).toEqual({ paths: ["income.dividends", "state.MO.refund"], reason_length: REASON.length });
    expect(JSON.stringify(audits[0]!.meta)).not.toContain("746");
  });

  it("refuses while the job is queued, and shows active overrides with the extraction", async () => {
    const busy = await admin.post(`/api/jobs/${jobId}/extraction-overrides`, { overrides: [{ path: "income.dividends", value: 700 }], reason: REASON });
    expect(busy.statusCode).toBe(400);
    const res = await admin.get(`/api/jobs/${jobId}/extraction`);
    expect(res.json().overrides.map((o: { path: string }) => o.path).sort()).toEqual(["income.dividends", "state.MO.refund"]);
  });

  it("replaces an override on the same field, keeping the old one in the log", async () => {
    await setStatus("needs_review");
    const res = await admin.post(`/api/jobs/${jobId}/extraction-overrides`, { overrides: [{ path: "income.dividends", value: 747 }], reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    const all = await ctx.db.select().from(extractionOverrides).where(eq(extractionOverrides.path, "income.dividends"));
    expect(all).toHaveLength(2);
    const active = all.filter((r) => !r.removedAt);
    expect(active).toHaveLength(1);
    expect(active[0]!.value).toBe(747);
  });

  it("removes an override, audits it, and re-runs from extract", async () => {
    await setStatus("failed");
    const [active] = await ctx.db
      .select()
      .from(extractionOverrides)
      .where(and(eq(extractionOverrides.path, "state.MO.refund"), isNull(extractionOverrides.removedAt)));
    const res = await admin.request("DELETE", `/api/jobs/${jobId}/extraction-overrides/${active!.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().overrides.map((o: { path: string }) => o.path)).toEqual(["income.dividends"]);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.resumeFrom).toBe("extract");
    await setStatus("failed");
    const again = await admin.request("DELETE", `/api/jobs/${jobId}/extraction-overrides/${active!.id}`);
    expect(again.statusCode).toBe(404);
  });

  it("lists the log for admins with counts by field, and exports CSV with formulas neutralized", async () => {
    await setStatus("failed");
    await admin.post(`/api/jobs/${jobId}/extraction-overrides`, { overrides: [{ path: "tax.other_taxes", value: 5 }], reason: "=HYPERLINK(1) reason long enough to pass" });
    const res = await admin.get("/api/extraction-overrides?days=30");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overrides.length).toBe(4);
    expect(body.byPath[0]).toEqual({ path: "income.dividends", count: 2 });
    const csv = await admin.get("/api/extraction-overrides?days=30&format=csv");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe(
      "created_at,job_id,software,tax_year,profile,path,field,pdf_page,pdf_line,pdf_label,extracted_value,override_value,reason,by,removed_at",
    );
    expect(csv.body).toContain(`"'=HYPERLINK(1) reason long enough to pass"`);
    expect(csv.body).toContain(`"Ordinary dividends (line 3b)"`);
    const staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    expect((await staff.get("/api/extraction-overrides")).statusCode).toBe(403);
  });

  it("clears the amounts when the job is purged and keeps the rest of the log", async () => {
    await setStatus("released");
    await runPurge(ctx.app, { jobId, everything: true });
    const rows = await ctx.db.select().from(extractionOverrides).where(eq(extractionOverrides.jobId, jobId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.value).toBeNull();
      expect(r.extractedValue).toBeNull();
      expect(r.valuesPurgedAt).not.toBeNull();
      expect(r.path).toBeTruthy();
      expect(r.reason.length).toBeGreaterThanOrEqual(20);
    }
  });
});
