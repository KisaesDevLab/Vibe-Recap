import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  isOverridePath,
  overridePathLabel,
  type ExtractionDto,
  type ExtractionOverrideDto,
  type ExtractionOverrideLogDto,
  type ExtractionOverrideLogResponse,
  type ExtractionResponse,
} from "@vibe-recap/shared";
import type { Db } from "../db/index.js";
import { extractionOverrides, files, jobs, type ExtractionOverride, type ReconException } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { loadJob, requeue } from "./jobs.js";

const REASON_MIN = "Reason must be at least 20 characters";

const overrideBody = z.object({
  overrides: z
    .array(
      z.object({
        path: z.string().refine(isOverridePath, "Not a figure that can be overridden"),
        value: z.number().int().min(-99_999_999_999).max(99_999_999_999),
      }),
    )
    .min(1)
    .max(40),
  reason: z.string().min(20, REASON_MIN).max(2000),
});

/** Statuses in which a job's figures cannot change: the worker has it, or it is out the door. */
const OVERRIDE_BLOCKED = ["queued", "processing", "released", "purged"];

/** The figure at `path` in an extraction ("state.MO.refund" included), or null when absent. */
function figureAt(doc: ExtractionDto | null, path: string): number | null {
  if (!doc) return null;
  const [section, key, field] = path.split(".");
  const v =
    section === "state"
      ? (doc.state.find((s) => s.code === key) as unknown as Record<string, unknown> | undefined)?.[field!]
      : (doc as unknown as Record<string, Record<string, unknown> | undefined>)[section!]?.[key!];
  return typeof v === "number" ? v : null;
}

function toOverrideDto(r: ExtractionOverride): ExtractionOverrideDto {
  return { id: r.id, path: r.path, value: r.value, extractedValue: r.extractedValue, reason: r.reason, by: r.createdByLabel, at: r.createdAt.toISOString() };
}

export async function activeOverrides(db: Db, jobId: string): Promise<ExtractionOverride[]> {
  return db
    .select()
    .from(extractionOverrides)
    .where(and(eq(extractionOverrides.jobId, jobId), isNull(extractionOverrides.removedAt)))
    .orderBy(asc(extractionOverrides.createdAt));
}

/** CSV cell; free text is prefixed so a spreadsheet never evaluates it as a formula. */
function csvText(v: unknown): string {
  return `"${String(v ?? "")
    .replace(/^([=+\-@\t\r])/, "'$1")
    .replace(/"/g, '""')}"`;
}

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
    const overrides = (await activeOverrides(app.db, id)).map(toOverrideDto);
    return { extraction: found?.data ?? null, sha256: found?.sha256 ?? null, reconExceptions: row.job.reconExceptions, overrides };
  });

  /**
   * Override extracted figures (Q66) when the profile misread a line: the preparer enters the
   * figure from the return with a reason of at least 20 characters. Each override is logged with
   * what the mapper read and where on the PDF it read it, so profile work can see which rule
   * misread which row. The job re-runs from `extract`, where the worker applies the overrides
   * before recon, then script, validate and verify. Verify still traces every amount in the
   * script to the PDF itself, so an override cannot put a figure in the video that the return
   * does not show. Amounts never go to the audit log or the application log.
   */
  app.post("/api/jobs/:id/extraction-overrides", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = overrideBody.parse(req.body);
    const reason = body.reason.trim();
    if (reason.length < 20) throw badRequest(REASON_MIN);
    const row = await loadJob(app.db, id);
    if (OVERRIDE_BLOCKED.includes(row.job.status)) throw badRequest(`Cannot override figures on a ${row.job.status} job`);
    const found = await readJson<ExtractionDto>(app, id, "extraction");
    // Without a stored extraction only a job that failed reading the return can take overrides:
    // they supply the required lines the mapper could not find.
    if (!found && !(row.job.status === "failed" && ["identify", "extract", "ocr"].includes(row.job.errorStep ?? ""))) {
      throw badRequest("No extraction to override yet");
    }
    const doc = found?.data ?? null;
    const paths = new Set<string>();
    for (const o of body.overrides) {
      if (paths.has(o.path)) throw badRequest(`${overridePathLabel(o.path)} is listed twice`);
      paths.add(o.path);
    }
    const user = req.auth!.user;
    const now = new Date();
    await app.db.transaction(async (tx) => {
      for (const o of body.overrides) {
        // What the mapper read: once overridden, the stored extraction carries the override, and
        // its `overrides` record keeps the original.
        const applied = doc?.overrides?.find((a) => a.path === o.path && !a.ignored);
        const extracted = applied ? (applied.extracted ?? null) : figureAt(doc, o.path);
        await tx
          .update(extractionOverrides)
          .set({ removedAt: now, removedBy: user.id, removedByLabel: user.email })
          .where(and(eq(extractionOverrides.jobId, id), eq(extractionOverrides.path, o.path), isNull(extractionOverrides.removedAt)));
        await tx.insert(extractionOverrides).values({
          jobId: id,
          path: o.path,
          value: o.value,
          extractedValue: extracted,
          reason,
          software: doc?.meta.software ?? row.job.software,
          taxYear: doc?.meta.tax_year ?? row.job.taxYear,
          profile: doc?.meta.profile ?? null,
          evidence: doc?.evidence?.[o.path] ?? null,
          createdBy: user.id,
          createdByLabel: user.email,
          createdAt: now,
        });
      }
    });
    await audit(app.db, {
      actor: actorOf(req),
      action: "job.extraction_override",
      target: { type: "job", id },
      ip: req.ip,
      meta: { paths: [...paths], reason_length: reason.length },
    });
    await requeue(app, id, "extract", "job.retry", actorOf(req), req.ip, { after: "extraction_override" });
    return { ok: true, overrides: (await activeOverrides(app.db, id)).map(toOverrideDto) };
  });

  /** Remove an override: the job re-runs from `extract` and the mapper's figure stands again. */
  app.delete("/api/jobs/:id/extraction-overrides/:overrideId", { preHandler: requireRole("preparer") }, async (req) => {
    const { id, overrideId } = req.params as { id: string; overrideId: string };
    const row = await loadJob(app.db, id);
    if (OVERRIDE_BLOCKED.includes(row.job.status)) throw badRequest(`Cannot change figures on a ${row.job.status} job`);
    if (!z.string().uuid().safeParse(overrideId).success) throw notFound("No active override with that id on this job");
    const user = req.auth!.user;
    const removed = await app.db
      .update(extractionOverrides)
      .set({ removedAt: new Date(), removedBy: user.id, removedByLabel: user.email })
      .where(and(eq(extractionOverrides.id, overrideId), eq(extractionOverrides.jobId, id), isNull(extractionOverrides.removedAt)))
      .returning();
    if (!removed[0]) throw notFound("No active override with that id on this job");
    await audit(app.db, {
      actor: actorOf(req),
      action: "job.extraction_override_removed",
      target: { type: "job", id },
      ip: req.ip,
      meta: { path: removed[0].path, override_id: overrideId },
    });
    await requeue(app, id, "extract", "job.retry", actorOf(req), req.ip, { after: "extraction_override_removed" });
    return { ok: true, overrides: (await activeOverrides(app.db, id)).map(toOverrideDto) };
  });

  /**
   * The override log (Q66), admin only: every override in the period, active or removed, with
   * where the mapper read the figure. Each override marks a line a profile misread; the counts by
   * field show which rules to fix first. `format=csv` downloads it, and the download is audited.
   */
  app.get("/api/extraction-overrides", { preHandler: requireRole("admin") }, async (req, reply) => {
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(3650).default(90), format: z.enum(["json", "csv"]).default("json") })
      .parse(req.query);
    const since = new Date(Date.now() - q.days * 86_400_000);
    const rows = await app.db
      .select({ o: extractionOverrides, jobStatus: jobs.status })
      .from(extractionOverrides)
      .innerJoin(jobs, eq(jobs.id, extractionOverrides.jobId))
      .where(gte(extractionOverrides.createdAt, since))
      .orderBy(desc(extractionOverrides.createdAt))
      .limit(5000);
    const list: ExtractionOverrideLogDto[] = rows.map(({ o, jobStatus }) => ({
      ...toOverrideDto(o),
      jobId: o.jobId,
      jobStatus,
      software: o.software,
      taxYear: o.taxYear,
      profile: o.profile,
      evidence: o.evidence,
      removedAt: o.removedAt?.toISOString() ?? null,
      removedBy: o.removedByLabel,
      valuesPurged: !!o.valuesPurgedAt,
    }));
    if (q.format === "csv") {
      const lines = ["created_at,job_id,software,tax_year,profile,path,field,pdf_page,pdf_line,pdf_label,extracted_value,override_value,reason,by,removed_at"];
      for (const r of list) {
        const ev = r.evidence?.[0];
        const cells = [r.at, r.jobId, r.software, r.taxYear, r.profile, r.path, overridePathLabel(r.path), ev?.page, ev?.line, ev?.label].map(csvText);
        cells.push(String(r.extractedValue ?? ""), String(r.value ?? ""), csvText(r.reason), csvText(r.by), csvText(r.removedAt));
        lines.push(cells.join(","));
      }
      await audit(app.db, { actor: actorOf(req), action: "extraction_override.export", ip: req.ip, meta: { rows: list.length, days: q.days } });
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", 'attachment; filename="extraction-overrides.csv"');
      return lines.join("\n") + "\n";
    }
    const counts = new Map<string, number>();
    for (const r of list) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
    const byPath = [...counts.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count);
    const out: ExtractionOverrideLogResponse = { overrides: list, byPath };
    return out;
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
