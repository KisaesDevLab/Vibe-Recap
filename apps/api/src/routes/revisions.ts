/**
 * Revision requests: a chat-style thread of change instructions per job. Each message is one
 * regenerate-with-instructions pass through the same validator, verifier, and render steps; a
 * rejected revision leaves the previous script, verification, and video untouched.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { RevisionDto } from "@vibe-recap/shared";
import { jobRevisions, type JobRevision } from "../db/schema.js";
import { badRequest } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { loadJob, requeue } from "./jobs.js";

const REVISABLE = new Set(["needs_review", "rejected", "approved", "failed"]);

export function toRevisionDto(r: JobRevision): RevisionDto {
  return {
    id: r.id,
    message: r.message,
    status: r.status as RevisionDto["status"],
    requestedBy: r.requestedByLabel,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    error: r.error,
    attempts: r.attempts.length,
    scriptSha256After: r.scriptSha256After,
  };
}

export async function revisionRoutes(app: FastifyInstance) {
  app.get("/api/jobs/:id/revisions", { preHandler: requireRole("staff") }, async (req) => {
    const { id } = req.params as { id: string };
    await loadJob(app.db, id);
    const rows = await app.db.select().from(jobRevisions).where(eq(jobRevisions.jobId, id)).orderBy(asc(jobRevisions.createdAt));
    return { revisions: rows.map(toRevisionDto) };
  });

  app.post("/api/jobs/:id/revisions", { preHandler: requireRole("preparer") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ message: z.string().min(3).max(2000) }).parse(req.body);
    const row = await loadJob(app.db, id);
    if (!REVISABLE.has(row.job.status)) throw badRequest(`Cannot request a revision on a ${row.job.status} job`);
    if (!row.job.scriptSha256) throw badRequest("No script yet; generate one first");
    const [pending] = await app.db
      .select({ id: jobRevisions.id })
      .from(jobRevisions)
      .where(and(eq(jobRevisions.jobId, id), eq(jobRevisions.status, "pending")))
      .limit(1);
    if (pending) throw badRequest("A revision is already in progress for this job");
    const user = req.auth!.user;
    const [rev] = await app.db
      .insert(jobRevisions)
      .values({
        jobId: id,
        requestedBy: user.id,
        requestedByLabel: user.email,
        message: body.message.trim(),
        previousStatus: row.job.status,
        scriptSha256Before: row.job.scriptSha256,
      })
      .returning();
    await audit(app.db, {
      actor: actorOf(req),
      action: "job.revision_request",
      target: { type: "job", id },
      ip: req.ip,
      meta: { revision_id: rev!.id, message_length: body.message.trim().length, previous_status: row.job.status },
    });
    await requeue(app, id, "script", "job.regenerate", actorOf(req), req.ip, { revision_id: rev!.id });
    reply.code(201);
    return toRevisionDto(rev!);
  });
}
