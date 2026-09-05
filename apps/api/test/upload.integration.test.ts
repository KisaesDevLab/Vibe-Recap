import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { StageDto } from "@vibe-recap/shared";
import { Client, createTestContext, servicesAvailable, TEST_REDIS_URL, type TestContext } from "./helpers.js";
import { clients } from "../src/db/schema.js";
import { sql } from "drizzle-orm";

const available = await servicesAvailable();
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures");

function sha(b: Buffer) {
  return createHash("sha256").update(b).digest("hex");
}

/** Build a multipart body by hand so tests do not need a browser FormData with Blob support. */
function multipart(parts: Array<{ name: string; data: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = "----recapTestBoundary" + Math.random().toString(36).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${p.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(p.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function fixture(name: string) {
  return fs.readFile(path.join(FIXTURES, name));
}

/** A tiny in-process ZIP writer (stored entries, no compression) for the batch test. */
function makeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data);
    centrals.push(central, name);
    offset += local.length + name.length + e.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

describe.skipIf(!available)("upload staging and queueing", () => {
  let ctx: TestContext;
  let c: Client;
  beforeAll(async () => {
    ctx = await createTestContext();
    c = new Client(ctx.app);
    await c.setup();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function stage(parts: Array<{ name: string; data: Buffer }>): Promise<StageDto> {
    const { body, contentType } = multipart(parts);
    const res = await c.post("/api/uploads/stage", body, { "content-type": contentType });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as StageDto;
  }

  it("rejects non-PDF, oversize, and encrypted PDFs as skipped rows", async () => {
    const big = Buffer.alloc(100 * 1024 * 1024 + 1, 0x20);
    big.write("%PDF-1.4", 0);
    const enc = Buffer.from("%PDF-1.4\n1 0 obj<</Filter/Standard>>endobj\ntrailer<</Root 2 0 R/Encrypt 1 0 R>>\n%%EOF");
    const dto = await stage([
      { name: "notes.txt", data: Buffer.from("hello") },
      { name: "huge.pdf", data: big },
      { name: "locked.pdf", data: enc },
    ]);
    expect(dto.files).toHaveLength(3);
    expect(dto.files.map((f) => f.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(dto.files[0]!.skipReason).toMatch(/not a PDF/);
    expect(dto.files[1]!.skipReason).toMatch(/100 MB/);
    expect(dto.files[2]!.skipReason).toMatch(/password/);
  }, 60_000);

  it("stages a single fixture, encrypts it, and queues a job with an id-only payload", async () => {
    const pdf = await fixture("ultratax-1040-2025-mfj-refund-mo.pdf");
    ctx.stager.bySha.set(sha(pdf), { ok: true, firstName: "Alex", lastName: "Fixture", spouseFirstName: "Jordan", taxYear: 2025, software: "ultratax", form: "1040", pageCount: 5 });
    const dto = await stage([{ name: "alex.pdf", data: pdf }]);
    const row = dto.files[0]!;
    expect(row.status).toBe("ok");
    expect(row.detected?.taxYear).toBe(2025);
    expect(row.match?.type).toBe("new");
    expect(row.newClientName).toBe("Fixture, Alex & Jordan");

    // encrypted at rest: the staged blob has no plaintext
    const blobDir = path.join(ctx.dataDir, "blobs", "staging", dto.id);
    const names = await fs.readdir(blobDir);
    const age = names.find((n) => n.endsWith(".age"))!;
    const onDisk = await fs.readFile(path.join(blobDir, age));
    expect(onDisk.includes("Fixture")).toBe(false);
    expect(onDisk.includes("%PDF")).toBe(false);

    const q = await c.post(`/api/uploads/stage/${dto.id}/queue`, {});
    expect(q.statusCode, q.body).toBe(201);
    const { batchId, jobIds } = q.json() as { batchId: string; jobIds: string[] };
    expect(jobIds).toHaveLength(1);

    // job row and blob moved under the job id
    const job = await c.get(`/api/jobs/${jobIds[0]}`);
    expect(job.statusCode).toBe(200);
    expect(job.json().status).toBe("queued");
    expect(job.json().clientName).toBe("Fixture, Alex & Jordan");
    expect(job.json().files.map((f: { kind: string }) => f.kind)).toEqual(["source"]);
    await expect(fs.access(blobDir)).rejects.toThrow();

    // queue payload is { jobId } only
    const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue("recap", { connection: redis });
    const waiting = await queue.getJobs(["waiting", "delayed", "active"]);
    const mine = waiting.find((j) => j.data.jobId === jobIds[0]);
    expect(mine).toBeDefined();
    expect(Object.keys(mine!.data)).toEqual(["jobId"]);
    await queue.close();
    await redis.quit();

    const batch = await c.get(`/api/batches/${batchId}`);
    expect(batch.json().jobs).toHaveLength(1);
    expect(batch.json().counts.queued).toBe(1);
  });

  it("stages a 25-file ZIP with pairs, one encrypted, and one non-PDF", async () => {
    const [ctxClient] = await ctx.db.insert(clients).values({ name: "Placeholder, Morgan", normalizedName: "placeholder, morgan" }).returning();
    const entries: Array<{ name: string; data: Buffer }> = [];
    const softwares = ["ultratax", "lacerte", "cch", "gosystem", "drake", "proseries"];
    // 6 x mfj current + 2 priors (pairs), 6 x single, 6 x hoh, 3 hoh priors => 23 PDFs, + encrypted + txt = 25
    for (const sw of softwares) {
      const cur = await fixture(`${sw}-1040-2025-mfj-refund-mo.pdf`);
      entries.push({ name: `mfj/${sw}.pdf`, data: cur });
      // only the ultratax file keeps the shared taxpayer name so exactly one prior-year pair forms
      ctx.stager.bySha.set(sha(cur), { ok: true, firstName: "Alex", lastName: sw === "ultratax" ? "Fixture" : `Fixture${sw}`, spouseFirstName: "Jordan", taxYear: 2025, software: sw, form: "1040", pageCount: 5 });
    }
    for (const sw of ["ultratax", "drake"]) {
      const prior = await fixture(`${sw}-1040-2024-mfj-refund-mo-prior.pdf`);
      // give each prior a distinct taxpayer so pairs are unambiguous
      entries.push({ name: `prior/${sw}.pdf`, data: prior });
      ctx.stager.bySha.set(sha(prior), { ok: true, firstName: "Alex", lastName: sw === "ultratax" ? "Fixture" : "Fixtureprior", spouseFirstName: "Jordan", taxYear: 2024, software: sw, form: "1040", pageCount: 4 });
    }
    for (const sw of softwares) {
      const single = await fixture(`${sw}-1040-2025-single-owed-itemized.pdf`);
      entries.push({ name: `single/${sw}.pdf`, data: single });
      ctx.stager.bySha.set(sha(single), { ok: true, firstName: "Casey", lastName: `Sample${sw}`, taxYear: 2025, software: sw, form: "1040", pageCount: 4 });
    }
    for (const sw of softwares) {
      const hoh = await fixture(`${sw}-1040-2025-hoh-refund-two-states.pdf`);
      entries.push({ name: `hoh/${sw}.pdf`, data: hoh });
      ctx.stager.bySha.set(sha(hoh), { ok: true, firstName: "Morgan", lastName: "Placeholder", taxYear: 2025, software: sw, form: "1040", pageCount: 4 });
    }
    for (const sw of ["cch", "gosystem", "proseries"]) {
      const p = await fixture(`${sw}-1040-2024-hoh-refund-two-states-prior.pdf`);
      entries.push({ name: `hohprior/${sw}.pdf`, data: p });
      ctx.stager.bySha.set(sha(p), { ok: true, firstName: "Morgan", lastName: `Placeholder${sw}`, taxYear: 2024, software: sw, form: "1040", pageCount: 3 });
    }
    entries.push({ name: "locked.pdf", data: Buffer.from("%PDF-1.4\ntrailer<</Encrypt 1 0 R>>") });
    entries.push({ name: "readme.txt", data: Buffer.from("not a return") });
    expect(entries).toHaveLength(25);

    const dto = await stage([{ name: "batch.zip", data: makeZip(entries) }]);
    expect(dto.files).toHaveLength(25);
    const ok = dto.files.filter((f) => f.status === "ok");
    const skipped = dto.files.filter((f) => f.status === "skipped");
    expect(ok).toHaveLength(23);
    expect(skipped.map((f) => f.skipReason)).toEqual(expect.arrayContaining([expect.stringMatching(/password/), expect.stringMatching(/not a PDF/)]));

    // only the ultratax mfj pair shares a taxpayer name across 2024/2025 unambiguously
    const paired = ok.filter((f) => f.priorFileId);
    expect(paired).toHaveLength(1);
    const priorRows = ok.filter((f) => f.role === "prior");
    expect(priorRows).toHaveLength(1);

    // every hoh file auto-matched the existing client exactly
    const hoh = ok.filter((f) => f.detected?.firstName === "Morgan" && f.detected.lastName === "Placeholder");
    expect(hoh).toHaveLength(6);
    for (const f of hoh) {
      expect(f.match?.type).toBe("exact");
      expect(f.clientId).toBe(ctxClient!.id);
    }

    const q = await c.post(`/api/uploads/stage/${dto.id}/queue`, { note: "phase 2 batch" });
    expect(q.statusCode, q.body).toBe(201);
    const { batchId, jobIds } = q.json() as { batchId: string; jobIds: string[] };
    expect(jobIds).toHaveLength(22);
    const batch = await c.get(`/api/batches/${batchId}`);
    expect(batch.json().fileCount).toBe(22);
    const withPrior = (batch.json().jobs as Array<{ hasPrior: boolean }>).filter((j) => j.hasPrior);
    expect(withPrior).toHaveLength(1);
    const clientList = await c.get("/api/clients");
    const names = (clientList.json().clients as Array<{ name: string }>).map((x) => x.name);
    expect(names.filter((n) => n === "Fixture, Alex & Jordan")).toHaveLength(1);
  }, 120_000);

  it("lets the preparer fix a row and refuses to queue rows without a client or year", async () => {
    const pdf = await fixture("proseries-1040-2025-single-owed-itemized.pdf");
    ctx.stager.bySha.set(sha(pdf), { ok: true, firstName: null, lastName: null, taxYear: null, software: "proseries", form: "1040", pageCount: 4 });
    const dto = await stage([{ name: "mystery.pdf", data: pdf }]);
    const row = dto.files[0]!;
    expect(row.warnings.join(" ")).toMatch(/tax year not detected/);
    expect(row.warnings.join(" ")).toMatch(/taxpayer name not detected/);
    const refused = await c.post(`/api/uploads/stage/${dto.id}/queue`, {});
    expect(refused.statusCode).toBe(400);
    const patched = await c.request("PATCH", `/api/uploads/stage/${dto.id}/files/${row.fileId}`, { taxYear: 2025, newClientName: "Mystery, Client" });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().files[0].warnings).toEqual([]);
    const q = await c.post(`/api/uploads/stage/${dto.id}/queue`, {});
    expect(q.statusCode).toBe(201);
  });

  it("warns on a duplicate upload for the same client within 30 days and audits each upload", async () => {
    const pdf = await fixture("lacerte-1040-2025-hoh-refund-two-states.pdf");
    ctx.stager.bySha.set(sha(pdf), { ok: true, firstName: "Morgan", lastName: "Placeholder", taxYear: 2025, software: "lacerte", form: "1040", pageCount: 4 });
    const dto = await stage([{ name: "again.pdf", data: pdf }]);
    expect(dto.files[0]!.warnings.join(" ")).toMatch(/already uploaded/);
    const rows = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'job.upload'`);
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(23);
  });

  it("staff can upload, viewer cannot", async () => {
    const { users } = await import("../src/db/schema.js");
    const { hashPassword } = await import("../src/auth/password.js");
    await ctx.db.insert(users).values({ email: "viewer@example.com", name: "V", role: "viewer", passwordHash: await hashPassword("viewer-password-long") });
    const v = new Client(ctx.app);
    await v.login("viewer@example.com", "viewer-password-long");
    const { body, contentType } = multipart([{ name: "x.pdf", data: Buffer.from("%PDF-1.4") }]);
    const res = await v.post("/api/uploads/stage", body, { "content-type": contentType });
    expect(res.statusCode).toBe(403);
  });
});
