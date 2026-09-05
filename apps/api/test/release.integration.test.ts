import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { batches, clients, files, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";

const available = await servicesAvailable();

function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, Buffer>();
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
    });
  });
}

describe.skipIf(!available)("release, downloads, packages, delivered", () => {
  let ctx: TestContext;
  let admin: Client;
  let staff: Client;
  let viewer: Client;
  let batchId: string;
  let jobA: string;
  let jobB: string;
  const payload = { video: Buffer.from("\x00\x00\x00\x18ftypmp42 fake video bytes"), vtt: Buffer.from("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhello\n"), txt: Buffer.from("hello\n") };

  async function seed(status: "approved" | "needs_review", clientName: string): Promise<string> {
    const me = (await admin.get("/api/auth/me")).json();
    const [client] = await ctx.db.insert(clients).values({ name: clientName, normalizedName: clientName.toLowerCase() }).returning();
    const [job] = await ctx.db.insert(jobs).values({ status, step: "ready", clientId: client!.id, batchId, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025, approvedScriptSha256: "b".repeat(64) }).returning();
    for (const [kind, data] of Object.entries(payload) as Array<[keyof typeof payload, Buffer]>) {
      const blob = await ctx.storage.put(job!.id, data);
      await ctx.db.insert(files).values({ id: blob.id, jobId: job!.id, kind, path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size });
    }
    const src = await ctx.storage.put(job!.id, Buffer.from("%PDF-1.4 fake source"));
    await ctx.db.insert(files).values({ id: src.id, jobId: job!.id, kind: "source", path: src.path, keyPath: src.keyPath, sha256: src.sha256, size: src.size });
    return job!.id;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    await ctx.db.insert(users).values([
      { email: "staff@example.com", name: "S", role: "staff", passwordHash: await hashPassword("staff-password-long") },
      { email: "viewer@example.com", name: "V", role: "viewer", passwordHash: await hashPassword("viewer-password-long") },
    ]);
    staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    viewer = new Client(ctx.app);
    await viewer.login("viewer@example.com", "viewer-password-long");
    const [batch] = await ctx.db.insert(batches).values({ uploadedBy: me.user.id, fileCount: 2 }).returning();
    batchId = batch!.id;
    jobA = await seed("approved", "Fixture, Alex & Jordan");
    jobB = await seed("needs_review", "Sample, Casey");
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("staff cannot download a needs_review video; viewer cannot download anything unreleased", async () => {
    expect((await staff.get(`/api/jobs/${jobB}/download/mp4`)).statusCode).toBe(403);
    expect((await viewer.get(`/api/jobs/${jobA}/download/mp4`)).statusCode).toBe(403);
    expect((await viewer.get(`/api/jobs/${jobA}/package.zip`)).statusCode).toBe(403);
  });

  it("release requires approved status and a preparer, then audits", async () => {
    expect((await staff.post(`/api/jobs/${jobA}/release`)).statusCode).toBe(403);
    expect((await admin.post(`/api/jobs/${jobB}/release`)).statusCode).toBe(400);
    const res = await admin.post(`/api/jobs/${jobA}/release`);
    expect(res.statusCode, res.body).toBe(200);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobA));
    expect(job!.status).toBe("released");
    expect(job!.releasedAt).not.toBeNull();
    const rows = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'job.release' and target_id = ${jobA}`);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("viewer downloads only released MP4/VTT/TXT, never the source or JSON; each download audited once", async () => {
    for (const key of ["mp4", "vtt", "txt"]) {
      const res = await viewer.get(`/api/jobs/${jobA}/download/${key}`);
      expect(res.statusCode, key).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/attachment; filename="Fixture-Alex-Jordan-2025-recap\./);
    }
    expect((await viewer.get(`/api/jobs/${jobA}/download/source`)).statusCode).toBe(403);
    expect((await viewer.get(`/api/jobs/${jobA}/download/extraction`)).statusCode).toBe(403);
    expect((await viewer.get(`/api/jobs/${jobA}/download/verification`)).statusCode).toBe(403);
    const rows = await ctx.db.execute<{ kind: string; n: number }>(sql`select meta->>'kind' as kind, count(*)::int as n from audit_events where action = 'job.download' and target_id = ${jobA} group by 1`);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
    expect(byKind).toEqual({ video: 1, vtt: 1, txt: 1 });
  });

  it("the package ZIP matches the individual downloads byte for byte", async () => {
    const res = await admin.get(`/api/jobs/${jobA}/package.zip`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("Fixture-Alex-Jordan-2025-recap.zip");
    const entries = await unzip(res.rawPayload);
    expect([...entries.keys()].sort()).toEqual(["Fixture-Alex-Jordan-2025-recap.mp4", "Fixture-Alex-Jordan-2025-recap.txt", "Fixture-Alex-Jordan-2025-recap.vtt"]);
    const mp4 = await admin.get(`/api/jobs/${jobA}/download/mp4`);
    expect(entries.get("Fixture-Alex-Jordan-2025-recap.mp4")!.equals(mp4.rawPayload)).toBe(true);
    expect(createHash("sha256").update(entries.get("Fixture-Alex-Jordan-2025-recap.vtt")!).digest("hex")).toBe(createHash("sha256").update(payload.vtt).digest("hex"));
  });

  it("delivered checkbox with a note is audited", async () => {
    const res = await staff.request("PATCH", `/api/jobs/${jobA}/delivered`, { delivered: true, note: "sent via portal 9/12" });
    expect(res.statusCode).toBe(200);
    const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobA));
    expect(job!.delivered).toBe(true);
    expect(job!.deliveredNote).toBe("sent via portal 9/12");
    const rows = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'job.delivered' and target_id = ${jobA}`);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("batch release-all and download-all: one outer ZIP of per-client ZIPs, one audit row per job", async () => {
    await ctx.db.update(jobs).set({ status: "approved" }).where(eq(jobs.id, jobB));
    const rel = await admin.post(`/api/batches/${batchId}/release-approved`);
    expect(rel.statusCode).toBe(200);
    expect(rel.json().released).toEqual([jobB]);
    const res = await admin.get(`/api/batches/${batchId}/released.zip`);
    expect(res.statusCode).toBe(200);
    const outer = await unzip(res.rawPayload);
    expect([...outer.keys()].sort()).toEqual(["Fixture-Alex-Jordan-2025-recap.zip", "Sample-Casey-2025-recap.zip"]);
    const inner = await unzip(outer.get("Sample-Casey-2025-recap.zip")!);
    expect([...inner.keys()].sort()).toEqual(["Sample-Casey-2025-recap.mp4", "Sample-Casey-2025-recap.txt", "Sample-Casey-2025-recap.vtt"]);
    const rows = await ctx.db.execute<{ target_id: string; n: number }>(sql`select target_id, count(*)::int as n from audit_events where action = 'job.download' and (meta->>'package') = 'true' group by 1`);
    const counts = Object.fromEntries(rows.map((r) => [r.target_id, Number(r.n)]));
    expect(counts[jobB]).toBe(3);
    expect(counts[jobA]).toBeGreaterThanOrEqual(3);
  });
});
