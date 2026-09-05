/**
 * Retention engine (Phase 8). The hourly purge is the only thing that deletes files.
 *
 * Windows (firm settings, per-client overrides, legal hold suspends everything):
 *   source PDFs         N days after upload            (source, prior)
 *   extraction + script N days after release           (extraction, script, verification)
 *   videos              N days after release           (video, vtt, txt, audio, slide)
 *   failed jobs         N days after failure           (everything on the job)
 * A file is due when the job reached the anchoring state at least N days ago. Jobs that were
 * never released keep their extraction/script/video until they fail or are purged by policy on
 * the source window only; "Purge now" for a client removes every file of that client's jobs.
 * Each purged file writes one audit row with the policy reason. The job moves to `purged`
 * when no unpurged files remain. Audit rows are never purged.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FileKind } from "@vibe-recap/shared";
import { clients, files, jobEvents, jobs, type Client, type FileRow, type Job } from "../db/schema.js";
import { audit, SYSTEM_RETENTION, type Actor } from "./audit.js";
import { getAllSettings } from "./settings.js";
import { heldJobIds } from "../routes/feedback.js";

const SOURCE_KINDS: FileKind[] = ["source", "prior"];
const EXTRACTION_KINDS: FileKind[] = ["extraction", "script", "verification"];
const VIDEO_KINDS: FileKind[] = ["video", "vtt", "txt", "audio", "slide"];

export interface PurgeCandidate {
  file: FileRow;
  job: Job;
  reason: string;
}

export interface PurgeResult {
  dryRun: boolean;
  candidates: PurgeCandidate[];
  purgedFiles: number;
  purgedJobs: number;
  skippedLegalHold: number;
  /** Files kept because a thumbs-down holds the job for study (Q46); released by time or an admin dismissal. */
  skippedFeedbackHold: number;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86400_000);
}

export function effectiveWindows(settings: Awaited<ReturnType<typeof getAllSettings>>, client: Pick<Client, "retentionSourceDays" | "retentionExtractionDays" | "retentionVideoDays">) {
  return {
    source: client.retentionSourceDays ?? settings.retention_source_days,
    extraction: client.retentionExtractionDays ?? settings.retention_extraction_days,
    video: client.retentionVideoDays ?? settings.retention_video_days,
    failed: settings.retention_failed_days,
  };
}

/** Which of a job's files are due at `now` under the policy, with the reason. */
export function dueFiles(job: Job, client: Client, jobFiles: FileRow[], windows: ReturnType<typeof effectiveWindows>, now: Date): PurgeCandidate[] {
  if (client.legalHold) return [];
  const out: PurgeCandidate[] = [];
  const live = jobFiles.filter((f) => !f.purgedAt);
  const sourceAnchor = job.readyAt ?? job.failedAt ?? null; // source retention starts once the job no longer needs the PDF (ready or failed); 0 = immediately after ready
  for (const f of live) {
    if (job.status === "failed" && job.failedAt && job.failedAt <= daysAgo(now, windows.failed)) {
      out.push({ file: f, job, reason: `failed job older than ${windows.failed} days` });
      continue;
    }
    if (SOURCE_KINDS.includes(f.kind)) {
      const anchor = sourceAnchor ?? job.createdAt;
      if (["needs_review", "approved", "released", "rejected", "failed", "purged"].includes(job.status) && anchor <= daysAgo(now, windows.source)) {
        out.push({ file: f, job, reason: `source PDF older than ${windows.source} days after processing` });
      }
      continue;
    }
    if (job.status === "released" && job.releasedAt) {
      if (EXTRACTION_KINDS.includes(f.kind) && job.releasedAt <= daysAgo(now, windows.extraction)) {
        out.push({ file: f, job, reason: `extraction/script older than ${windows.extraction} days after release` });
      } else if (VIDEO_KINDS.includes(f.kind) && job.releasedAt <= daysAgo(now, windows.video)) {
        out.push({ file: f, job, reason: `video older than ${windows.video} days after release` });
      }
    }
  }
  return out;
}

export async function collectCandidates(app: FastifyInstance, now: Date, clientId?: string, everything = false): Promise<{ candidates: PurgeCandidate[]; skippedLegalHold: number; skippedFeedbackHold: number }> {
  const settings = await getAllSettings(app.db);
  const rows = await app.db
    .select({ job: jobs, client: clients })
    .from(jobs)
    .innerJoin(clients, eq(clients.id, jobs.clientId))
    .where(and(sql`${jobs.status} <> 'purged'`, clientId ? eq(jobs.clientId, clientId) : undefined));
  const held = await heldJobIds(app.db, now);
  const candidates: PurgeCandidate[] = [];
  let skippedLegalHold = 0;
  let skippedFeedbackHold = 0;
  for (const { job, client } of rows) {
    const jobFiles = await app.db.select().from(files).where(and(eq(files.jobId, job.id), isNull(files.purgedAt)));
    if (jobFiles.length === 0) continue;
    if (client.legalHold) {
      skippedLegalHold += jobFiles.length;
      continue;
    }
    if (held.has(job.id)) {
      // A thumbs-down keeps everything about the job, including under "purge now", until the hold
      // lapses or an admin dismisses the feedback on the Quality page.
      skippedFeedbackHold += jobFiles.length;
      continue;
    }
    if (everything) {
      candidates.push(...jobFiles.map((file) => ({ file, job, reason: "purge now (admin)" })));
      continue;
    }
    candidates.push(...dueFiles(job, client, jobFiles, effectiveWindows(settings, client), now));
  }
  return { candidates, skippedLegalHold, skippedFeedbackHold };
}

export async function runPurge(
  app: FastifyInstance,
  opts: { now?: Date; dryRun?: boolean; actor?: Actor; clientId?: string; everything?: boolean; ip?: string | null } = {},
): Promise<PurgeResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM_RETENTION;
  const { candidates, skippedLegalHold, skippedFeedbackHold } = await collectCandidates(app, now, opts.clientId, opts.everything);
  if (opts.dryRun) return { dryRun: true, candidates, purgedFiles: 0, purgedJobs: 0, skippedLegalHold, skippedFeedbackHold };

  const touchedJobs = new Set<string>();
  for (const c of candidates) {
    await app.storage.shred(c.file.path, c.file.keyPath);
    await app.db.update(files).set({ purgedAt: now }).where(eq(files.id, c.file.id));
    await audit(app.db, {
      actor,
      action: "file.purge",
      target: { type: "job", id: c.job.id },
      ip: opts.ip ?? null,
      meta: { file_id: c.file.id, kind: c.file.kind, sha256: c.file.sha256, reason: c.reason, policy: actor.label === SYSTEM_RETENTION.label ? "retention" : "manual" },
    });
    touchedJobs.add(c.job.id);
  }
  let purgedJobs = 0;
  for (const jobId of touchedJobs) {
    const remaining = await app.db.select({ id: files.id }).from(files).where(and(eq(files.jobId, jobId), isNull(files.purgedAt)));
    if (remaining.length === 0) {
      await app.db.update(jobs).set({ status: "purged", purgedAt: now, updatedAt: now }).where(eq(jobs.id, jobId));
      await app.db.insert(jobEvents).values({ jobId, status: "purged", message: `all files purged by ${actor.label}` });
      purgedJobs++;
    }
  }
  if (candidates.length) app.log.info({ purgedFiles: candidates.length, purgedJobs, skippedFeedbackHold, actor: actor.label }, "purge run");
  return { dryRun: false, candidates, purgedFiles: candidates.length, purgedJobs, skippedLegalHold, skippedFeedbackHold };
}

/** Counts of files by kind due within the next `days` days. */
export async function retentionReport(app: FastifyInstance, days = 7): Promise<{ dueByKind: Record<string, number>; dueNow: number; legalHoldClients: number; feedbackHoldJobs: number }> {
  const horizon = new Date(Date.now() + days * 86400_000);
  const { candidates } = await collectCandidates(app, horizon);
  const nowRun = await collectCandidates(app, new Date());
  const dueByKind: Record<string, number> = {};
  for (const c of candidates) dueByKind[c.file.kind] = (dueByKind[c.file.kind] ?? 0) + 1;
  const [held] = await app.db.select({ n: sql<number>`count(*)` }).from(clients).where(eq(clients.legalHold, true));
  const feedbackHeld = await heldJobIds(app.db, new Date());
  return { dueByKind, dueNow: nowRun.candidates.length, legalHoldClients: Number(held?.n ?? 0), feedbackHoldJobs: feedbackHeld.size };
}

/**
 * Startup self-check: blobs on disk with no live DB row are moved to /data/orphans, never deleted.
 * Runs once per API start and logs counts only.
 */
export async function orphanCheck(app: FastifyInstance): Promise<{ moved: number }> {
  const known = new Set((await app.db.select({ path: files.path }).from(files)).map((r) => r.path));
  const onDisk = await app.storage.listBlobPaths();
  let moved = 0;
  for (const rel of onDisk) {
    if (known.has(rel) || rel.startsWith("blobs/staging/")) continue;
    const src = app.storage.abs(rel);
    const dest = path.join(app.storage.dataDir, "orphans", rel.replace(/^blobs\//, "").replace(/\//g, "__"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest).catch(() => undefined);
    const key = rel.replace(/\.age$/, ".key");
    await fs.rename(app.storage.abs(key), dest.replace(/\.age$/, ".key")).catch(() => undefined);
    moved++;
  }
  if (moved) {
    app.log.warn({ moved }, "orphan blobs quarantined to /data/orphans");
    await audit(app.db, { actor: { id: null, label: "system:startup" }, action: "storage.orphans_quarantined", meta: { moved } });
  }
  return { moved };
}

export const KINDS_FOR_TESTS = { SOURCE_KINDS, EXTRACTION_KINDS, VIDEO_KINDS };
void inArray;
