import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { validateScript, type ExtractionDto, type ScriptResponse, type VerificationDto, type VerificationResponse } from "@vibe-recap/shared";
import { files, jobs } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { readJson } from "./extraction.js";
import { loadJob, requeue } from "./jobs.js";

const saveBody = z.object({ script: z.string().min(1).max(20_000) });

async function readScript(app: FastifyInstance, jobId: string): Promise<{ script: string; sha256: string } | null> {
  const [row] = await app.db
    .select()
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.kind, "script"), isNull(files.purgedAt)))
    .limit(1);
  if (!row) return null;
  const bytes = await app.storage.get(row.path, row.keyPath);
  return { script: Buffer.from(bytes).toString("utf8"), sha256: row.sha256 };
}

const EDITABLE = new Set(["needs_review", "failed", "rejected", "approved"]);

export async function scriptRoutes(app: FastifyInstance) {
  app.get("/api/jobs/:id/script", { preHandler: requireRole("staff") }, async (req): Promise<ScriptResponse> => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    const found = await readScript(app, id);
    return {
      script: found?.script ?? null,
      sha256: found?.sha256 ?? null,
      extractionSha256: row.job.extractionSha256,
      generatedFromExtraction: row.job.extractionSha256 !== null && found !== null,
    };
  });

  /**
   * Manual edit. Validated here with the shared rules (same numbers-must-exist check), stored,
   * then the worker re-runs validate -> verify -> render. No audio until both gates pass.
   */
  app.put("/api/jobs/:id/script", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = saveBody.parse(req.body);
    const row = await loadJob(app.db, id);
    if (!EDITABLE.has(row.job.status)) throw badRequest(`Cannot edit the script of a ${row.job.status} job`);
    const ex = await readJson<ExtractionDto>(app, id, "extraction");
    if (!ex) throw badRequest("No extraction yet; the script cannot be validated");
    const script = body.script.replace(/\r\n/g, "\n").trim() + "\n";
    const v = validateScript(script, ex.data);
    if (!v.ok) throw badRequest("Script failed validation", { errors: v.errors, wordCount: v.wordCount });
    const sha256 = createHash("sha256").update(script).digest("hex");
    // replace the stored script blob
    const old = await app.db.select().from(files).where(and(eq(files.jobId, id), eq(files.kind, "script"))).limit(5);
    for (const f of old) {
      await app.storage.shred(f.path, f.keyPath);
      await app.db.delete(files).where(eq(files.id, f.id));
    }
    const blob = await app.storage.put(id, Buffer.from(script, "utf8"));
    await app.db.insert(files).values({ id: blob.id, jobId: id, kind: "script", path: blob.path, keyPath: blob.keyPath, sha256, size: blob.size });
    await app.db.update(jobs).set({ scriptSha256: sha256, updatedAt: new Date() }).where(eq(jobs.id, id));
    await audit(app.db, { actor: actorOf(req), action: "job.script_edit", target: { type: "job", id }, ip: req.ip, meta: { sha256, words: v.wordCount } });
    await requeue(app, id, "validate", "job.rerender", actorOf(req), req.ip, { after: "script_edit" });
    return { ok: true, sha256, wordCount: v.wordCount };
  });

  /** Regenerate: a fresh LLM pass from the current extraction, then validate, verify, render. */
  app.post("/api/jobs/:id/regenerate", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    if (!EDITABLE.has(row.job.status)) throw badRequest(`Cannot regenerate the script of a ${row.job.status} job`);
    if (!row.job.extractionSha256) throw badRequest("No extraction yet");
    await requeue(app, id, "script", "job.regenerate", actorOf(req), req.ip);
    return { ok: true };
  });

  app.get("/api/jobs/:id/verification", { preHandler: requireRole("staff") }, async (req): Promise<VerificationResponse> => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    const found = await readJson<VerificationDto>(app, id, "verification");
    const stale = found ? row.job.scriptSha256 !== null && found.data.script_sha256 !== row.job.scriptSha256 : false;
    return { verification: found?.data ?? null, sha256: found?.sha256 ?? null, stale };
  });

  /** Source PDF for the verification panel (preparer and up; every read is audited). */
  app.get("/api/jobs/:id/source.pdf", { preHandler: requireRole("preparer") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const kind = (req.query as { kind?: string }).kind === "prior" ? "prior" : "source";
    await loadJob(app.db, id);
    const [row] = await app.db
      .select()
      .from(files)
      .where(and(eq(files.jobId, id), eq(files.kind, kind), isNull(files.purgedAt)))
      .limit(1);
    if (!row) throw notFound("Source PDF is no longer available (purged)");
    const bytes = await app.storage.get(row.path, row.keyPath);
    await audit(app.db, { actor: actorOf(req), action: "file.read", target: { type: "job", id }, ip: req.ip, meta: { kind, sha256: row.sha256, purpose: "verification_view" } });
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `inline; filename="${kind}-${id.slice(0, 8)}.pdf"`);
    reply.header("cache-control", "no-store");
    return reply.send(Buffer.from(bytes));
  });
}
