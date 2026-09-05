import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { roleAtLeast, type VerificationDto } from "@vibe-recap/shared";
import { files, jobEvents, jobs, type FileRow } from "../db/schema.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { readJson } from "./extraction.js";
import { batchDto, listJobSummaries, loadJob, requeue } from "./jobs.js";

const rejectBody = z.object({ reason: z.string().min(3).max(2000) });

async function fileOf(app: FastifyInstance, jobId: string, kind: FileRow["kind"]): Promise<FileRow | null> {
  const [row] = await app.db
    .select()
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.kind, kind), isNull(files.purgedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Approval preconditions (docs/PLAN.md §5a, CLAUDE.md): the job is in needs_review, the stored
 * script matches jobs.script_sha256, the extraction hash matches, verification.json exists,
 * was produced for exactly that script, and has no flagged item. Any miss refuses the approval.
 */
export async function approvalCheck(app: FastifyInstance, jobId: string): Promise<{ ok: true; scriptSha: string; extractionSha: string; verificationSha: string } | { ok: false; reason: string }> {
  const row = await loadJob(app.db, jobId);
  const j = row.job;
  if (j.status !== "needs_review") return { ok: false, reason: `job is ${j.status}, not needs_review` };
  const script = await fileOf(app, jobId, "script");
  const extraction = await fileOf(app, jobId, "extraction");
  const video = await fileOf(app, jobId, "video");
  if (!script || !extraction) return { ok: false, reason: "script or extraction is missing" };
  if (!video) return { ok: false, reason: "video has not been rendered" };
  if (j.scriptSha256 !== script.sha256) return { ok: false, reason: "script hash is stale; re-render first" };
  if (j.extractionSha256 !== extraction.sha256) return { ok: false, reason: "extraction hash is stale; re-extract first" };
  const ver = await readJson<VerificationDto>(app, jobId, "verification");
  if (!ver) return { ok: false, reason: "verification.json is missing" };
  if (ver.data.script_sha256 !== script.sha256) return { ok: false, reason: "verification is stale: it was produced for a different script" };
  if (!ver.data.passed || ver.data.items.some((i) => i.status === "flagged")) return { ok: false, reason: "verification has flagged items" };
  return { ok: true, scriptSha: script.sha256, extractionSha: extraction.sha256, verificationSha: ver.sha256 };
}

export async function approveJob(app: FastifyInstance, jobId: string, actor: ReturnType<typeof actorOf>, ip: string, bulk = false) {
  const check = await approvalCheck(app, jobId);
  if (!check.ok) throw badRequest(`Cannot approve: ${check.reason}`);
  const now = new Date();
  await app.db
    .update(jobs)
    .set({
      status: "approved",
      approvedAt: now,
      approvedBy: actor.id,
      approvedScriptSha256: check.scriptSha,
      approvedExtractionSha256: check.extractionSha,
      approvedVerificationSha256: check.verificationSha,
      updatedAt: now,
    })
    .where(eq(jobs.id, jobId));
  await app.db.insert(jobEvents).values({ jobId, status: "approved", step: null, message: `approved by ${actor.label}` });
  await audit(app.db, {
    actor,
    action: "job.approve",
    target: { type: "job", id: jobId },
    ip,
    meta: { script_sha256: check.scriptSha, extraction_sha256: check.extractionSha, verification_sha256: check.verificationSha, ...(bulk ? { bulk: true } : {}) },
  });
}

export async function reviewRoutes(app: FastifyInstance) {
  app.get("/api/jobs/:id/approval", { preHandler: requireRole("staff") }, async (req) => {
    const { id } = req.params as { id: string };
    const check = await approvalCheck(app, id);
    return check.ok ? { ok: true } : { ok: false, reason: check.reason };
  });

  app.post("/api/jobs/:id/approve", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    await approveJob(app, id, actorOf(req), req.ip);
    return { ok: true };
  });

  app.post("/api/jobs/:id/reject", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = rejectBody.parse(req.body);
    const row = await loadJob(app.db, id);
    if (!["needs_review", "approved"].includes(row.job.status)) throw badRequest(`Cannot reject a ${row.job.status} job`);
    const now = new Date();
    await app.db
      .update(jobs)
      .set({ status: "rejected", rejectedAt: now, rejectedReason: body.reason.trim(), approvedAt: null, approvedBy: null, updatedAt: now })
      .where(eq(jobs.id, id));
    await app.db.insert(jobEvents).values({ jobId: id, status: "rejected", message: body.reason.trim().slice(0, 500) });
    await audit(app.db, { actor: actorOf(req), action: "job.reject", target: { type: "job", id }, ip: req.ip, meta: { reason_length: body.reason.trim().length } });
    return { ok: true };
  });

  /** Re-render from tts with the current (already validated and verified) script. */
  app.post("/api/jobs/:id/rerender", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    if (!["rejected", "needs_review", "failed"].includes(row.job.status)) throw badRequest(`Cannot re-render a ${row.job.status} job`);
    const ver = await readJson<VerificationDto>(app, id, "verification");
    const from = ver && ver.data.passed && ver.data.script_sha256 === row.job.scriptSha256 ? "tts" : "validate";
    await requeue(app, id, from, "job.rerender", actorOf(req), req.ip);
    return { ok: true, resumeFrom: from };
  });

  /** Approve every needs_review job in the batch with zero flags and no recon exceptions. One audit row each. */
  app.post("/api/batches/:id/approve-verified", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    await batchDto(app.db, id, false);
    const candidates = await listJobSummaries(app.db, { batchId: id, status: ["needs_review"], limit: 500 });
    const approved: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const j of candidates) {
      if (j.reconExceptionCount) {
        skipped.push({ id: j.id, reason: "has reconciliation exceptions; approve individually" });
        continue;
      }
      const check = await approvalCheck(app, j.id);
      if (!check.ok) {
        skipped.push({ id: j.id, reason: check.reason });
        continue;
      }
      await approveJob(app, j.id, actorOf(req), req.ip, true);
      approved.push(j.id);
    }
    return { approved, skipped };
  });

  /** Video / captions / transcript preview. Staff and viewers see them only once approved. */
  for (const [kind, contentType, ext] of [
    ["video", "video/mp4", "mp4"],
    ["vtt", "text/vtt; charset=utf-8", "vtt"],
    ["txt", "text/plain; charset=utf-8", "txt"],
  ] as const) {
    app.get(`/api/jobs/:id/preview.${ext}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = await loadJob(app.db, id);
      const role = req.auth!.user.role;
      const reviewer = roleAtLeast(role, "preparer");
      if (!reviewer) {
        if (role === "staff" && !["approved", "released"].includes(row.job.status)) throw forbidden("Available after approval");
        if (role === "viewer" && row.job.status !== "released") throw forbidden("Available after release");
      }
      const file = await fileOf(app, id, kind);
      if (!file) throw notFound(`No ${kind} for this job yet`);
      const bytes = Buffer.from(await app.storage.get(file.path, file.keyPath));
      await audit(app.db, { actor: actorOf(req), action: "file.read", target: { type: "job", id }, ip: req.ip, meta: { kind, sha256: file.sha256, purpose: "preview" } });
      reply.header("content-type", contentType);
      reply.header("cache-control", "no-store");
      reply.header("accept-ranges", "bytes");
      const range = req.headers.range;
      if (range && kind === "video") {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), bytes.length - 1) : bytes.length - 1;
        reply.code(206);
        reply.header("content-range", `bytes ${start}-${end}/${bytes.length}`);
        reply.header("content-length", String(end - start + 1));
        return reply.send(bytes.subarray(start, end + 1));
      }
      reply.header("content-length", String(bytes.length));
      return reply.send(bytes);
    });
  }
}
