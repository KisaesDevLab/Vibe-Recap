import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BatchDto, DashboardDto, FileDto, JobDetailDto, JobEventDto, JobSummaryDto } from "@vibe-recap/shared";
import type { Db } from "../db/index.js";
import { batches, clients, files, jobEvents, jobs, users, type Job } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";

type JobRow = { job: Job; clientName: string; hasPrior: boolean };

export function toJobSummary(r: JobRow): JobSummaryDto {
  const j = r.job;
  return {
    id: j.id,
    status: j.status,
    step: j.step,
    clientId: j.clientId,
    clientName: r.clientName,
    batchId: j.batchId,
    taxYear: j.taxYear,
    software: j.software,
    errorStep: j.errorStep,
    errorMessage: j.errorMessage,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    readyAt: j.readyAt?.toISOString() ?? null,
    approvedAt: j.approvedAt?.toISOString() ?? null,
    releasedAt: j.releasedAt?.toISOString() ?? null,
    hasPrior: r.hasPrior,
    reconExceptionCount: j.reconExceptions.length,
  };
}

export interface JobFilter {
  status?: Job["status"][];
  clientId?: string;
  batchId?: string;
  limit?: number;
}

export async function listJobSummaries(db: Db, f: JobFilter): Promise<JobSummaryDto[]> {
  const conds: SQL[] = [];
  if (f.status?.length) conds.push(inArray(jobs.status, f.status));
  if (f.clientId) conds.push(eq(jobs.clientId, f.clientId));
  if (f.batchId) conds.push(eq(jobs.batchId, f.batchId));
  const rows = await db
    .select({ job: jobs, clientName: clients.name, hasPrior: sql<boolean>`${jobs.priorSha256} is not null` })
    .from(jobs)
    .innerJoin(clients, eq(clients.id, jobs.clientId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(f.limit ?? 100);
  return rows.map(toJobSummary);
}

export async function loadJob(db: Db, id: string): Promise<JobRow> {
  const rows = await db
    .select({ job: jobs, clientName: clients.name, hasPrior: sql<boolean>`${jobs.priorSha256} is not null` })
    .from(jobs)
    .innerJoin(clients, eq(clients.id, jobs.clientId))
    .where(eq(jobs.id, id))
    .limit(1);
  if (!rows[0]) throw notFound("Job not found");
  return rows[0];
}

export async function jobDetail(db: Db, id: string): Promise<JobDetailDto> {
  const row = await loadJob(db, id);
  const [uploader] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.job.uploadedBy)).limit(1);
  const fileRows = await db.select().from(files).where(eq(files.jobId, id)).orderBy(files.kind, files.seq);
  const eventRows = await db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).orderBy(jobEvents.at, jobEvents.id);
  const fileDtos: FileDto[] = fileRows.map((f) => ({
    id: f.id,
    kind: f.kind,
    sha256: f.sha256,
    size: f.size,
    seq: f.seq,
    createdAt: f.createdAt.toISOString(),
    purgedAt: f.purgedAt?.toISOString() ?? null,
  }));
  const events: JobEventDto[] = eventRows.map((e) => ({ id: e.id, at: e.at.toISOString(), step: e.step, status: e.status, message: e.message, meta: e.meta }));
  return {
    ...toJobSummary(row),
    note: row.job.note,
    uploadedBy: uploader?.email ?? "",
    pageCount: row.job.pageCount,
    files: fileDtos,
    events,
    rejectedReason: row.job.rejectedReason,
    delivered: row.job.delivered,
    deliveredNote: row.job.deliveredNote,
  };
}

export async function batchCounts(db: Db, batchId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, n: sql<number>`count(*)` })
    .from(jobs)
    .where(eq(jobs.batchId, batchId))
    .groupBy(jobs.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function batchDto(db: Db, id: string, withJobs: boolean): Promise<BatchDto> {
  const [b] = await db.select({ batch: batches, uploader: users.email }).from(batches).innerJoin(users, eq(users.id, batches.uploadedBy)).where(eq(batches.id, id)).limit(1);
  if (!b) throw notFound("Batch not found");
  const dto: BatchDto = {
    id: b.batch.id,
    createdAt: b.batch.createdAt.toISOString(),
    uploadedBy: b.uploader,
    fileCount: b.batch.fileCount,
    note: b.batch.note,
    counts: await batchCounts(db, id),
  };
  if (withJobs) dto.jobs = await listJobSummaries(db, { batchId: id, limit: 500 });
  return dto;
}

/** Re-queue a job from a given step. Used by retry, re-extract, regenerate, re-render. */
export async function requeue(app: FastifyInstance, jobId: string, resumeFrom: string, action: string, actor: ReturnType<typeof actorOf>, ip: string, meta: Record<string, unknown> = {}) {
  const now = new Date();
  await app.db
    .update(jobs)
    .set({ status: "queued", step: null, resumeFrom, errorStep: null, errorMessage: null, queuedAt: now, updatedAt: now })
    .where(eq(jobs.id, jobId));
  await app.db.insert(jobEvents).values({ jobId, status: "queued", step: resumeFrom, message: `${action} from ${resumeFrom}` });
  await audit(app.db, { actor, action, target: { type: "job", id: jobId }, ip, meta: { resume_from: resumeFrom, ...meta } });
  await app.queues.enqueueRecap(jobId);
}

export async function jobRoutes(app: FastifyInstance) {
  app.get("/api/jobs", async (req) => {
    const q = req.query as { status?: string; clientId?: string; batchId?: string; limit?: string };
    const status = q.status ? (q.status.split(",") as Job["status"][]) : undefined;
    return { jobs: await listJobSummaries(app.db, { status, clientId: q.clientId, batchId: q.batchId, limit: Math.min(Number(q.limit ?? 100), 500) }) };
  });

  app.get("/api/jobs/:id", async (req) => {
    const { id } = req.params as { id: string };
    return jobDetail(app.db, id);
  });

  app.post("/api/jobs/:id/retry", { preHandler: requireRole("staff") }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadJob(app.db, id);
    if (row.job.status !== "failed") throw badRequest("Only failed jobs can be retried");
    const from = row.job.errorStep ?? "ingest";
    await requeue(app, id, from, "job.retry", actorOf(req), req.ip);
    return { ok: true, resumeFrom: from };
  });

  app.get("/api/batches", async () => {
    const rows = await app.db.select({ id: batches.id }).from(batches).orderBy(desc(batches.createdAt)).limit(50);
    return { batches: await Promise.all(rows.map((r) => batchDto(app.db, r.id, false))) };
  });

  app.get("/api/batches/:id", async (req) => {
    const { id } = req.params as { id: string };
    return batchDto(app.db, id, true);
  });

  app.get("/api/dashboard", async (): Promise<DashboardDto> => {
    const [processing, needsReview, recent] = await Promise.all([
      listJobSummaries(app.db, { status: ["queued", "processing"], limit: 50 }),
      listJobSummaries(app.db, { status: ["needs_review"], limit: 50 }),
      listJobSummaries(app.db, { limit: 20 }),
    ]);
    const countRows = await app.db.select({ status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status);
    const counts: Record<string, number> = {};
    for (const r of countRows) counts[r.status] = Number(r.n);
    const activeIds = await app.db
      .selectDistinct({ batchId: jobs.batchId })
      .from(jobs)
      .where(and(inArray(jobs.status, ["queued", "processing", "needs_review", "failed"]), sql`${jobs.batchId} is not null`));
    const activeBatches = await Promise.all(activeIds.filter((r) => r.batchId).map((r) => batchDto(app.db, r.batchId!, false)));
    activeBatches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    let queue = { waiting: 0, active: 0, failed: 0 };
    try {
      const c = await app.queues.counts();
      queue = { waiting: c.waiting ?? 0, active: c.active ?? 0, failed: c.failed ?? 0 };
    } catch {
      /* redis hiccup: leave zeros */
    }
    return { processing, needsReview, recent, activeBatches: activeBatches.slice(0, 10), counts, queue };
  });
}
