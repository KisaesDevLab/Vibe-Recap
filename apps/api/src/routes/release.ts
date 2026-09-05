/**
 * Release and download (Phase 7). Delivery is download only (L11): no share links, no portal.
 * Every download writes one audit row with user, IP, file kind, and sha256.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { roleAtLeast, type FileKind, type Role } from "@vibe-recap/shared";
import { clients, files, jobEvents, jobs, type FileRow, type Job } from "../db/schema.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { batchDto, listJobSummaries, loadJob } from "./jobs.js";

const DOWNLOADABLE: Record<string, { kind: FileKind; contentType: string; ext: string; minRole: Role; statuses: Job["status"][] }> = {
  mp4: { kind: "video", contentType: "video/mp4", ext: "mp4", minRole: "viewer", statuses: ["released"] },
  vtt: { kind: "vtt", contentType: "text/vtt; charset=utf-8", ext: "vtt", minRole: "viewer", statuses: ["released"] },
  txt: { kind: "txt", contentType: "text/plain; charset=utf-8", ext: "txt", minRole: "viewer", statuses: ["released"] },
  extraction: { kind: "extraction", contentType: "application/json", ext: "extraction.json", minRole: "preparer", statuses: ["needs_review", "approved", "released", "rejected", "failed"] },
  verification: { kind: "verification", contentType: "application/json", ext: "verification.json", minRole: "preparer", statuses: ["needs_review", "approved", "released", "rejected", "failed"] },
  source: { kind: "source", contentType: "application/pdf", ext: "source.pdf", minRole: "preparer", statuses: ["queued", "processing", "needs_review", "approved", "released", "rejected", "failed"] },
};

function safeName(s: string): string {
  return (
    s
      .replace(/[,&/]+/g, " ")
      .replace(/[^A-Za-z0-9._ -]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .slice(0, 60) || "client"
  );
}

async function fileRow(app: FastifyInstance, jobId: string, kind: FileKind): Promise<FileRow | null> {
  const [row] = await app.db
    .select()
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.kind, kind), isNull(files.purgedAt)))
    .limit(1);
  return row ?? null;
}

/** Role/state gate shared by single downloads and packages. Throws on refusal. */
function gate(role: Role, job: Job, spec: (typeof DOWNLOADABLE)[string]) {
  if (!roleAtLeast(role, spec.minRole)) throw forbidden(`Requires ${spec.minRole} role`);
  // staff may download approved deliverables too (PLAN §6: "download after release"; preparers approve)
  const allowed = roleAtLeast(role, "preparer") && ["video", "vtt", "txt"].includes(spec.kind) ? [...spec.statuses, "approved", "needs_review"] : spec.statuses;
  if (!allowed.includes(job.status)) throw forbidden(`Available after ${spec.statuses[0] === "released" ? "release" : "processing"}`);
}

async function sendFile(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, job: Job, key: string, clientName: string) {
  const spec = DOWNLOADABLE[key];
  if (!spec) throw notFound("Unknown download");
  gate(req.auth!.user.role, job, spec);
  const row = await fileRow(app, job.id, spec.kind);
  if (!row) throw notFound(`No ${spec.kind} file (purged or not produced)`);
  const bytes = Buffer.from(await app.storage.get(row.path, row.keyPath));
  await audit(app.db, {
    actor: actorOf(req),
    action: "job.download",
    target: { type: "job", id: job.id },
    ip: req.ip,
    meta: { kind: spec.kind, sha256: row.sha256, size: row.size },
  });
  const base = `${safeName(clientName)}-${job.taxYear ?? "year"}-recap`;
  reply.header("content-type", spec.contentType);
  reply.header("content-disposition", `attachment; filename="${base}.${spec.ext}"`);
  reply.header("content-length", String(bytes.length));
  reply.header("cache-control", "no-store");
  return reply.send(bytes);
}

/** MP4 + VTT + TXT as one ZIP. Returns the archive entries so the batch route can nest them. */
async function packageEntries(app: FastifyInstance, req: FastifyRequest, job: Job, clientName: string): Promise<Array<{ name: string; data: Buffer }>> {
  const base = `${safeName(clientName)}-${job.taxYear ?? "year"}-recap`;
  const out: Array<{ name: string; data: Buffer }> = [];
  for (const key of ["mp4", "vtt", "txt"] as const) {
    const spec = DOWNLOADABLE[key]!;
    gate(req.auth!.user.role, job, spec);
    const row = await fileRow(app, job.id, spec.kind);
    if (!row) throw notFound(`No ${spec.kind} file for job ${job.id.slice(0, 8)}`);
    out.push({ name: `${base}.${spec.ext}`, data: Buffer.from(await app.storage.get(row.path, row.keyPath)) });
    await audit(app.db, { actor: actorOf(req), action: "job.download", target: { type: "job", id: job.id }, ip: req.ip, meta: { kind: spec.kind, sha256: row.sha256, size: row.size, package: true } });
  }
  return out;
}

function zipStream(reply: FastifyReply, filename: string, build: (archive: archiver.Archiver) => Promise<void>) {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new PassThrough();
  archive.on("error", (err) => out.destroy(err));
  archive.pipe(out);
  reply.header("content-type", "application/zip");
  reply.header("content-disposition", `attachment; filename="${filename}"`);
  reply.header("cache-control", "no-store");
  void build(archive).then(() => archive.finalize()).catch((err) => out.destroy(err as Error));
  return reply.send(out);
}

export async function releaseRoutes(app: FastifyInstance) {
  app.post("/api/jobs/:id/release", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    if (row.job.status !== "approved") throw badRequest(`Only approved jobs can be released (this one is ${row.job.status})`);
    const now = new Date();
    await app.db.update(jobs).set({ status: "released", releasedAt: now, releasedBy: req.auth!.user.id, updatedAt: now }).where(eq(jobs.id, id));
    await app.db.insert(jobEvents).values({ jobId: id, status: "released", message: `released by ${req.auth!.user.email}` });
    await audit(app.db, { actor: actorOf(req), action: "job.release", target: { type: "job", id }, ip: req.ip, meta: { script_sha256: row.job.approvedScriptSha256 } });
    return { ok: true };
  });

  app.get("/api/jobs/:id/download/:key", async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const row = await loadJob(app.db, id);
    return sendFile(app, req, reply, row.job, key, row.clientName);
  });

  app.get("/api/jobs/:id/package.zip", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    const entries = await packageEntries(app, req, row.job, row.clientName);
    const name = `${safeName(row.clientName)}-${row.job.taxYear ?? "year"}-recap.zip`;
    return zipStream(reply, name, async (archive) => {
      for (const e of entries) archive.append(e.data, { name: e.name });
    });
  });

  app.patch("/api/jobs/:id/delivered", { preHandler: requireRole("staff") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ delivered: z.boolean(), note: z.string().max(500).nullable().optional() }).parse(req.body);
    await loadJob(app.db, id);
    await app.db.update(jobs).set({ delivered: body.delivered, deliveredNote: body.note ?? null, updatedAt: new Date() }).where(eq(jobs.id, id));
    await audit(app.db, { actor: actorOf(req), action: body.delivered ? "job.delivered" : "job.undelivered", target: { type: "job", id }, ip: req.ip, meta: { has_note: !!body.note } });
    return { ok: true };
  });

  app.post("/api/batches/:id/release-approved", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    await batchDto(app.db, id, false);
    const approved = await listJobSummaries(app.db, { batchId: id, status: ["approved"], limit: 500 });
    const now = new Date();
    for (const j of approved) {
      await app.db.update(jobs).set({ status: "released", releasedAt: now, releasedBy: req.auth!.user.id, updatedAt: now }).where(eq(jobs.id, j.id));
      await app.db.insert(jobEvents).values({ jobId: j.id, status: "released", message: `released by ${req.auth!.user.email} (batch)` });
      await audit(app.db, { actor: actorOf(req), action: "job.release", target: { type: "job", id: j.id }, ip: req.ip, meta: { bulk: true } });
    }
    return { released: approved.map((j) => j.id) };
  });

  /** One outer ZIP containing each released job's package ZIP. */
  app.get("/api/batches/:id/released.zip", async (req, reply) => {
    const { id } = req.params as { id: string };
    await batchDto(app.db, id, false);
    const released = await listJobSummaries(app.db, { batchId: id, status: ["released"], limit: 500 });
    if (released.length === 0) throw notFound("No released jobs in this batch");
    const inner: Array<{ name: string; entries: Array<{ name: string; data: Buffer }> }> = [];
    for (const j of released) {
      const row = await loadJob(app.db, j.id);
      const [client] = await app.db.select({ name: clients.name }).from(clients).where(eq(clients.id, row.job.clientId));
      inner.push({ name: `${safeName(client?.name ?? row.clientName)}-${row.job.taxYear ?? "year"}-recap.zip`, entries: await packageEntries(app, req, row.job, row.clientName) });
    }
    return zipStream(reply, `batch-${id.slice(0, 8)}-released.zip`, async (archive) => {
      for (const pkg of inner) {
        const innerZip = archiver("zip", { zlib: { level: 6 } });
        const chunks: Buffer[] = [];
        innerZip.on("data", (c: Buffer) => chunks.push(c));
        for (const e of pkg.entries) innerZip.append(e.data, { name: e.name });
        await innerZip.finalize();
        archive.append(Buffer.concat(chunks), { name: pkg.name });
      }
    });
  });
}
