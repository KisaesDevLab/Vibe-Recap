import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ExtractionDto, ExtractionResponse } from "@vibe-recap/shared";
import { files, jobs, type ReconException } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { loadJob, requeue } from "./jobs.js";

const exceptionBody = z.object({
  check: z.string().min(1).max(80),
  reason: z.string().min(20, "Reason must be at least 20 characters").max(2000),
});

export async function readJson<T>(app: FastifyInstance, jobId: string, kind: "extraction" | "verification"): Promise<{ data: T; sha256: string } | null> {
  const [row] = await app.db
    .select()
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.kind, kind), isNull(files.purgedAt)))
    .limit(1);
  if (!row) return null;
  const bytes = await app.storage.get(row.path, row.keyPath);
  return { data: JSON.parse(Buffer.from(bytes).toString("utf8")) as T, sha256: row.sha256 };
}

export async function extractionRoutes(app: FastifyInstance) {
  /** Extracted JSON (read-only; L15). Roles: staff and up. */
  app.get("/api/jobs/:id/extraction", { preHandler: requireRole("staff") }, async (req): Promise<ExtractionResponse> => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    const found = await readJson<ExtractionDto>(app, id, "extraction");
    if (found) {
      await audit(app.db, { actor: actorOf(req), action: "file.read", target: { type: "job", id }, ip: req.ip, meta: { kind: "extraction", sha256: found.sha256 } });
    }
    return { extraction: found?.data ?? null, sha256: found?.sha256 ?? null, reconExceptions: row.job.reconExceptions };
  });

  /** Re-extract: re-runs identify through recon (and onward if the extraction changed). */
  app.post("/api/jobs/:id/re-extract", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    if (["queued", "processing", "released", "purged"].includes(row.job.status)) {
      throw badRequest(`Cannot re-extract a ${row.job.status} job`);
    }
    await requeue(app, id, "identify", "job.reextract", actorOf(req), req.ip);
    return { ok: true };
  });

  /**
   * Downgrade a named recon check to a warning for this job only (L16). Requires a reason of
   * at least 20 characters, is audited, and re-runs recon so the job can proceed. The check still
   * runs and still reports its mismatch.
   */
  app.post("/api/jobs/:id/recon-exceptions", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = exceptionBody.parse(req.body);
    const row = await loadJob(app.db, id);
    if (row.job.status !== "failed" || row.job.errorStep !== "recon") {
      throw badRequest("Recon exceptions can only be added to a job that failed at recon");
    }
    const found = await readJson<ExtractionDto>(app, id, "extraction");
    const known = found?.data.recon.checks.map((c) => c.name) ?? [];
    if (!known.includes(body.check)) throw notFound(`No recon check named ${body.check} on this job`);
    if (row.job.reconExceptions.some((e) => e.check === body.check)) throw badRequest("That check is already downgraded");
    const user = req.auth!.user;
    const entry: ReconException = { check: body.check, reason: body.reason.trim(), by: user.email, at: new Date().toISOString() };
    const next = [...row.job.reconExceptions, entry];
    await app.db.update(jobs).set({ reconExceptions: next, updatedAt: new Date() }).where(eq(jobs.id, id));
    await audit(app.db, {
      actor: actorOf(req),
      action: "job.recon_exception",
      target: { type: "job", id },
      ip: req.ip,
      meta: { check: body.check, reason_length: body.reason.trim().length },
    });
    await requeue(app, id, "recon", "job.retry", actorOf(req), req.ip, { after: "recon_exception", check: body.check });
    return { ok: true, reconExceptions: next };
  });
}
