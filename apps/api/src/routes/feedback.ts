/**
 * Preparer feedback on finished recaps (QUESTIONS.md Q46).
 *
 * A thumbs-up or thumbs-down per user per job; a thumbs-down names one or more reasons and may
 * carry a note. A thumbs-down also places the job's files on hold for FEEDBACK_HOLD_DAYS so the
 * failure can be studied: the purge engine skips held jobs until the hold lapses or an admin
 * dismisses the feedback. Admins see every open thumbs-down, counts by reason, and can download a
 * diagnostic bundle (extraction, script, verification, events with attempts, and the source PDF)
 * for a job. Feedback rows themselves are never purged.
 */
import archiver from "archiver";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { FEEDBACK_HOLD_DAYS, FEEDBACK_REASON_CODES, type FeedbackAdminRowDto, type FeedbackDto, type FeedbackListDto, type JobStatus } from "@vibe-recap/shared";
import { clients, files, jobEvents, jobFeedback, jobRevisions, jobs, type JobFeedback } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { loadJob } from "./jobs.js";
import { toRevisionDto } from "./revisions.js";

const FEEDBACK_STATUSES = new Set<JobStatus>(["needs_review", "approved", "released", "rejected", "failed"]);

export function toFeedbackDto(r: JobFeedback): FeedbackDto {
  return {
    id: r.id,
    jobId: r.jobId,
    verdict: r.verdict as "up" | "down",
    reasons: r.reasons,
    note: r.note,
    by: r.userLabel,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    holdUntil: r.holdUntil?.toISOString() ?? null,
    dismissedAt: r.dismissedAt?.toISOString() ?? null,
    dismissedBy: r.dismissedByLabel,
  };
}

/** Job ids whose files are on a feedback hold at `now`. */
export async function heldJobIds(db: FastifyInstance["db"], now: Date): Promise<Set<string>> {
  const rows = await db
    .select({ jobId: jobFeedback.jobId })
    .from(jobFeedback)
    .where(and(eq(jobFeedback.verdict, "down"), isNull(jobFeedback.dismissedAt), gt(jobFeedback.holdUntil, now)));
  return new Set(rows.map((r) => r.jobId));
}

function zipStream(reply: FastifyReply, filename: string, build: (archive: archiver.Archiver) => Promise<void>) {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new PassThrough();
  archive.pipe(out);
  reply.header("content-type", "application/zip");
  reply.header("content-disposition", `attachment; filename="${filename}"`);
  reply.header("cache-control", "no-store");
  void build(archive).then(() => archive.finalize()).catch((err) => out.destroy(err as Error));
  return reply.send(out);
}

export async function feedbackRoutes(app: FastifyInstance) {
  app.get("/api/jobs/:id/feedback", { preHandler: requireRole("staff") }, async (req) => {
    const { id } = req.params as { id: string };
    await loadJob(app.db, id);
    const rows = await app.db.select().from(jobFeedback).where(eq(jobFeedback.jobId, id)).orderBy(desc(jobFeedback.updatedAt));
    return { feedback: rows.map(toFeedbackDto), reasons: FEEDBACK_REASON_CODES };
  });

  /** One verdict per user per job; sending again replaces it. */
  app.post("/api/jobs/:id/feedback", { preHandler: requireRole("staff") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        verdict: z.enum(["up", "down"]),
        reasons: z.array(z.string().max(40)).max(FEEDBACK_REASON_CODES.length).default([]),
        note: z.string().max(1000).nullable().optional(),
      })
      .parse(req.body);
    const row = await loadJob(app.db, id);
    if (!FEEDBACK_STATUSES.has(row.job.status)) throw badRequest(`Feedback is for finished jobs; this one is ${row.job.status}`);
    const reasons = [...new Set(body.reasons)];
    const unknown = reasons.filter((r) => !(FEEDBACK_REASON_CODES as string[]).includes(r));
    if (unknown.length) throw badRequest(`Unknown reason(s): ${unknown.join(", ")}`);
    if (body.verdict === "down" && reasons.length === 0) throw badRequest("Pick at least one reason for a thumbs-down");
    if (reasons.includes("other") && !(body.note ?? "").trim()) throw badRequest('Say what went wrong in the note when choosing "Something else"');
    const user = req.auth!.user;
    const now = new Date();
    const values = {
      jobId: id,
      userId: user.id,
      userLabel: user.email,
      verdict: body.verdict,
      reasons: body.verdict === "down" ? reasons : [],
      note: (body.note ?? "").trim() || null,
      holdUntil: body.verdict === "down" ? new Date(now.getTime() + FEEDBACK_HOLD_DAYS * 86400_000) : null,
      dismissedAt: null,
      dismissedBy: null,
      dismissedByLabel: null,
      updatedAt: now,
    };
    const [saved] = await app.db
      .insert(jobFeedback)
      .values(values)
      .onConflictDoUpdate({ target: [jobFeedback.jobId, jobFeedback.userId], set: values })
      .returning();
    await app.db.insert(jobEvents).values({ jobId: id, status: row.job.status, message: `feedback: thumbs ${body.verdict}${reasons.length ? ` (${reasons.join(", ")})` : ""} by ${user.email}` });
    await audit(app.db, {
      actor: actorOf(req),
      action: "job.feedback",
      target: { type: "job", id },
      ip: req.ip,
      meta: { verdict: body.verdict, reasons, has_note: !!values.note, hold_until: values.holdUntil?.toISOString() ?? null },
    });
    reply.code(201);
    return toFeedbackDto(saved!);
  });

  /** Admin view: open thumbs-downs by default (`scope=all` for everything), plus counts. */
  app.get("/api/feedback", { preHandler: requireRole("admin") }, async (req) => {
    const q = req.query as { scope?: string; days?: string; limit?: string };
    const days = Math.min(365, Math.max(1, Number(q.days ?? 90) || 90));
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 200) || 200));
    const since = new Date(Date.now() - days * 86400_000);
    const scopeAll = q.scope === "all";
    const conds = scopeAll ? undefined : and(eq(jobFeedback.verdict, "down"), isNull(jobFeedback.dismissedAt));
    const rows = await app.db
      .select({ fb: jobFeedback, job: jobs, clientName: clients.name })
      .from(jobFeedback)
      .innerJoin(jobs, eq(jobs.id, jobFeedback.jobId))
      .innerJoin(clients, eq(clients.id, jobs.clientId))
      .where(conds)
      .orderBy(desc(jobFeedback.updatedAt))
      .limit(limit);
    const [total] = await app.db.select({ n: sql<number>`count(*)` }).from(jobFeedback).where(conds);
    const purgedJobs = new Set(
      (
        await app.db
          .select({ jobId: files.jobId })
          .from(files)
          .where(and(eq(files.kind, "source"), sql`${files.purgedAt} is not null`))
      ).map((r) => r.jobId),
    );
    const recent = await app.db.select().from(jobFeedback).where(gt(jobFeedback.updatedAt, since));
    const byReason: Record<string, number> = {};
    let up = 0;
    let down = 0;
    for (const r of recent) {
      if (r.verdict === "up") up++;
      else {
        down++;
        for (const reason of r.reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
      }
    }
    const held = await heldJobIds(app.db, new Date());
    const out: FeedbackListDto = {
      stats: { days, up, down, byReason, openHolds: held.size },
      total: Number(total?.n ?? 0),
      rows: rows.map(
        ({ fb, job, clientName }): FeedbackAdminRowDto => ({
          ...toFeedbackDto(fb),
          clientId: job.clientId,
          clientName,
          taxYear: job.taxYear,
          jobStatus: job.status,
          software: job.software,
          filesPurged: purgedJobs.has(job.id),
        }),
      ),
    };
    return out;
  });

  /** Releases the retention hold; the feedback row stays for the record. */
  app.post("/api/feedback/:id/dismiss", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db.select().from(jobFeedback).where(eq(jobFeedback.id, id)).limit(1);
    if (!row) throw notFound("Feedback not found");
    if (row.dismissedAt) return toFeedbackDto(row);
    const user = req.auth!.user;
    const now = new Date();
    const [saved] = await app.db
      .update(jobFeedback)
      .set({ dismissedAt: now, dismissedBy: user.id, dismissedByLabel: user.email, updatedAt: now })
      .where(eq(jobFeedback.id, id))
      .returning();
    await audit(app.db, { actor: actorOf(req), action: "feedback.dismiss", target: { type: "job", id: row.jobId }, ip: req.ip, meta: { feedback_id: id, verdict: row.verdict, reasons: row.reasons } });
    return toFeedbackDto(saved!);
  });

  /**
   * Everything needed to reproduce a failure, as one ZIP: the job's status and events (script
   * attempts included), the feedback and revision threads, extraction, verification, script, and
   * the source PDF when it is still on disk. Admin only; every download is audited.
   */
  app.get("/api/feedback/:id/bundle.zip", { preHandler: requireRole("admin") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [fb] = await app.db.select().from(jobFeedback).where(eq(jobFeedback.id, id)).limit(1);
    if (!fb) throw notFound("Feedback not found");
    const row = await loadJob(app.db, fb.jobId);
    const job = row.job;
    const events = await app.db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)).orderBy(jobEvents.at);
    const allFeedback = await app.db.select().from(jobFeedback).where(eq(jobFeedback.jobId, job.id));
    const revisions = await app.db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)).orderBy(jobRevisions.createdAt);
    const jobFiles = await app.db.select().from(files).where(eq(files.jobId, job.id));
    const manifest = {
      generatedAt: new Date().toISOString(),
      job: {
        id: job.id,
        status: job.status,
        step: job.step,
        taxYear: job.taxYear,
        software: job.software,
        form: job.form,
        pageCount: job.pageCount,
        textCoverage: job.textCoverage,
        errorStep: job.errorStep,
        errorMessage: job.errorMessage,
        reconExceptions: job.reconExceptions,
        sourceSha256: job.sourceSha256,
        extractionSha256: job.extractionSha256,
        scriptSha256: job.scriptSha256,
        verificationSha256: job.verificationSha256,
        createdAt: job.createdAt,
        readyAt: job.readyAt,
      },
      clientName: row.clientName,
      events: events.map((e) => ({ at: e.at, status: e.status, step: e.step, message: e.message, meta: e.meta })),
      feedback: allFeedback.map(toFeedbackDto),
      revisions: revisions.map(toRevisionDto),
      files: jobFiles.map((f) => ({ kind: f.kind, seq: f.seq, sha256: f.sha256, size: f.size, purged: !!f.purgedAt })),
    };
    const wanted: Array<{ kind: string; name: string }> = [
      { kind: "extraction", name: "extraction.json" },
      { kind: "verification", name: "verification.json" },
      { kind: "script", name: "script.md" },
      { kind: "source", name: "source.pdf" },
      { kind: "prior", name: "prior.pdf" },
    ];
    await audit(app.db, { actor: actorOf(req), action: "feedback.bundle", target: { type: "job", id: job.id }, ip: req.ip, meta: { feedback_id: id } });
    return zipStream(reply, `recap-feedback-${job.id.slice(0, 8)}.zip`, async (archive) => {
      archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
      for (const w of wanted) {
        const f = jobFiles.find((x) => x.kind === w.kind && !x.purgedAt);
        if (!f) continue;
        archive.append(Buffer.from(await app.storage.get(f.path, f.keyPath)), { name: w.name });
      }
    });
  });
}
