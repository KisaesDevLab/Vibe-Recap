/**
 * Upload staging. Rows live in Redis for one hour; bytes live encrypted under
 * blobs/staging/<stageId>/ until the preparer clicks Queue, which moves them under
 * blobs/<jobId>/ and creates the batch + jobs rows. Nothing touches the `jobs` table
 * before Queue. Expired stages are swept by a cron in the API.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { ClientMatch, DetectedInfo, StageDto, StagedFileDto, StagedFilePatch } from "@vibe-recap/shared";
import type { Db } from "../db/index.js";
import { batches, clients, files, jobs } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { audit, type Actor } from "./audit.js";
import { isEncryptedPdf, isPdf, MAX_PDF_BYTES } from "./pdfcheck.js";
import { sha256Hex, Storage, type StoredBlob } from "./storage.js";
import type { Stager } from "./queue.js";

export const STAGE_TTL_SECONDS = 3600;
const FUZZY_THRESHOLD = 0.85;

interface StagedFile extends StagedFileDto {
  blob: StoredBlob;
}

interface Stage {
  id: string;
  uploadedBy: string;
  createdAt: string;
  files: StagedFile[];
}

export function normalizeClientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9&, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clientNameFor(d: DetectedInfo): string | null {
  if (!d.lastName || !d.firstName) return null;
  const first = d.spouseFirstName ? `${d.firstName} & ${d.spouseFirstName}` : d.firstName;
  return `${d.lastName}, ${first}`;
}

/** Key used to group a taxpayer across years: last + first name only (spouse may vary). */
function pairingKey(d: DetectedInfo | null): string | null {
  if (!d?.lastName || !d.firstName) return null;
  return normalizeClientName(`${d.lastName}, ${d.firstName}`);
}

export interface EnqueueFn {
  (jobId: string): Promise<void>;
}

export class StagingService {
  constructor(
    private readonly redis: Redis,
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly stager: Stager,
    private readonly enqueue: EnqueueFn,
    private readonly ttl = STAGE_TTL_SECONDS,
  ) {}

  private key(id: string) {
    return `stage:${id}`;
  }

  private async save(stage: Stage): Promise<void> {
    await this.redis.set(this.key(stage.id), JSON.stringify(stage), "EX", this.ttl);
  }

  private async load(id: string): Promise<Stage> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) throw notFound("Staging session expired or not found");
    return JSON.parse(raw) as Stage;
  }

  async create(userId: string): Promise<Stage> {
    const stage: Stage = { id: randomUUID(), uploadedBy: userId, createdAt: new Date().toISOString(), files: [] };
    await this.save(stage);
    return stage;
  }

  toDto(stage: Stage): StageDto {
    const expiresAt = new Date(new Date(stage.createdAt).getTime() + this.ttl * 1000).toISOString();
    return {
      id: stage.id,
      createdAt: stage.createdAt,
      expiresAt,
      files: stage.files.map(({ blob: _blob, ...rest }) => rest),
    };
  }

  async get(id: string, userId: string): Promise<StageDto> {
    const stage = await this.load(id);
    if (stage.uploadedBy !== userId) throw notFound("Staging session expired or not found");
    return this.toDto(stage);
  }

  /**
   * Validate, encrypt, and identify one uploaded PDF. Rejections are recorded as skipped rows
   * so the preparer sees them; they never stop the rest of the batch.
   */
  async addFile(stage: Stage, originalName: string, data: Uint8Array): Promise<StagedFile> {
    const fileId = randomUUID();
    const base: StagedFile = {
      fileId,
      originalName: path.basename(originalName).slice(0, 200),
      sha256: sha256Hex(data),
      size: data.byteLength,
      status: "ok",
      role: "source",
      detected: null,
      match: null,
      clientId: null,
      newClientName: null,
      taxYear: null,
      priorFileId: null,
      note: null,
      include: true,
      warnings: [],
      blob: { path: "", keyPath: "", sha256: "", size: 0 },
    };
    const skip = (reason: string) => {
      base.status = "skipped";
      base.skipReason = reason;
      base.include = false;
      stage.files.push(base);
      return base;
    };
    if (data.byteLength === 0) return skip("empty file");
    if (data.byteLength > MAX_PDF_BYTES) return skip("larger than 100 MB");
    if (!isPdf(data)) return skip("not a PDF");
    if (isEncryptedPdf(data)) return skip("PDF is password-protected; remove the password and upload again");
    if (stage.files.some((f) => f.status === "ok" && f.sha256 === base.sha256)) return skip("duplicate of another file in this upload");

    base.blob = await this.storage.put(`staging/${stage.id}`, data, fileId);
    const result = await this.stager.stage(stage.id, fileId);
    if (!result.ok) {
      await this.storage.shred(base.blob.path, base.blob.keyPath);
      return skip(result.error ?? "could not read PDF");
    }
    base.detected = {
      firstName: result.firstName ?? null,
      lastName: result.lastName ?? null,
      spouseFirstName: result.spouseFirstName ?? null,
      taxYear: result.taxYear ?? null,
      software: result.software ?? null,
      form: result.form ?? null,
      pageCount: result.pageCount ?? null,
    };
    base.taxYear = base.detected.taxYear;
    if (result.form && result.form !== "1040" && result.form !== "1040-SR") {
      base.warnings.push(`detected ${result.form}; only Form 1040 packages are supported in v1`);
    }
    if (!base.taxYear) base.warnings.push("tax year not detected; set it before queueing");
    base.match = await this.matchClient(base.detected);
    if (base.match.type === "exact" || base.match.type === "suggested") {
      base.clientId = base.match.type === "exact" ? base.match.clientId! : null;
    } else {
      base.newClientName = clientNameFor(base.detected);
      if (!base.newClientName) base.warnings.push("taxpayer name not detected; pick a client before queueing");
    }
    if (base.clientId) await this.dedupeWarning(base);
    stage.files.push(base);
    return base;
  }

  private async matchClient(d: DetectedInfo): Promise<ClientMatch> {
    const name = clientNameFor(d);
    if (!name) return { type: "new" };
    const norm = normalizeClientName(name);
    const exact = await this.db.select().from(clients).where(eq(clients.normalizedName, norm)).limit(1);
    if (exact[0]) return { type: "exact", clientId: exact[0].id, clientName: exact[0].name, score: 1 };
    // also try without the spouse ("last, first") so a prior single-filer year still matches
    const single = normalizeClientName(`${d.lastName}, ${d.firstName}`);
    const rows = await this.db.execute<{ id: string; name: string; score: number }>(sql`
      select id, name, greatest(similarity(normalized_name, ${norm}), similarity(normalized_name, ${single})) as score
      from clients
      where greatest(similarity(normalized_name, ${norm}), similarity(normalized_name, ${single})) >= ${FUZZY_THRESHOLD}
      order by score desc limit 1`);
    const best = rows[0];
    if (best) return { type: "suggested", clientId: best.id, clientName: best.name, score: Number(best.score) };
    return { type: "new" };
  }

  private async dedupeWarning(f: StagedFile): Promise<void> {
    if (!f.clientId) return;
    const cutoff = new Date(Date.now() - 30 * 86400_000);
    const dup = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.sourceSha256, f.sha256), eq(jobs.clientId, f.clientId), gt(jobs.createdAt, cutoff)))
      .limit(1);
    if (dup[0]) f.warnings.push(`identical PDF was already uploaded for this client in the last 30 days (job ${dup[0].id.slice(0, 8)})`);
  }

  /** Pair prior-year files with their current-year file: same taxpayer, years N and N-1. */
  autoPair(stage: Stage): void {
    const groups = new Map<string, StagedFile[]>();
    for (const f of stage.files) {
      if (f.status !== "ok") continue;
      const k = pairingKey(f.detected);
      if (!k) continue;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    for (const group of groups.values()) {
      const byYear = new Map<number, StagedFile[]>();
      for (const f of group) if (f.taxYear) byYear.set(f.taxYear, [...(byYear.get(f.taxYear) ?? []), f]);
      for (const [year, current] of byYear) {
        const prior = byYear.get(year - 1);
        if (current.length === 1 && prior && prior.length === 1 && !byYear.get(year + 1)) {
          const cur = current[0]!;
          const pri = prior[0]!;
          cur.priorFileId = pri.fileId;
          pri.role = "prior";
          pri.include = false;
        }
      }
    }
  }

  async finalize(stage: Stage): Promise<StageDto> {
    this.autoPair(stage);
    await this.save(stage);
    return this.toDto(stage);
  }

  async updateFile(stageId: string, userId: string, fileId: string, patch: StagedFilePatch): Promise<StageDto> {
    const stage = await this.load(stageId);
    if (stage.uploadedBy !== userId) throw notFound("Staging session expired or not found");
    const f = stage.files.find((x) => x.fileId === fileId);
    if (!f) throw notFound("File not in this staging session");
    if (patch.clientId !== undefined) {
      if (patch.clientId) {
        const [c] = await this.db.select().from(clients).where(eq(clients.id, patch.clientId)).limit(1);
        if (!c) throw badRequest("Unknown client");
        f.clientId = c.id;
        f.newClientName = null;
        f.match = { type: "exact", clientId: c.id, clientName: c.name, score: 1 };
      } else {
        f.clientId = null;
      }
    }
    if (patch.newClientName !== undefined) {
      f.newClientName = patch.newClientName?.trim() || null;
      if (f.newClientName) f.clientId = null;
    }
    if (patch.taxYear !== undefined) {
      if (patch.taxYear !== null && (patch.taxYear < 2010 || patch.taxYear > 2040)) throw badRequest("Tax year out of range");
      f.taxYear = patch.taxYear;
    }
    if (patch.note !== undefined) f.note = patch.note?.trim().slice(0, 2000) || null;
    if (patch.include !== undefined) f.include = patch.include && f.status === "ok" && f.role === "source";
    if (patch.priorFileId !== undefined) {
      // release the old prior
      const old = stage.files.find((x) => x.fileId === f.priorFileId);
      if (old) {
        old.role = "source";
        old.include = old.status === "ok";
      }
      f.priorFileId = null;
      if (patch.priorFileId) {
        const p = stage.files.find((x) => x.fileId === patch.priorFileId);
        if (!p || p.status !== "ok" || p.fileId === f.fileId) throw badRequest("Invalid prior-year file");
        const taken = stage.files.find((x) => x.priorFileId === p.fileId && x.fileId !== f.fileId);
        if (taken) throw badRequest("That file is already paired with another return");
        p.role = "prior";
        p.include = false;
        f.priorFileId = p.fileId;
      }
    }
    f.warnings = f.warnings.filter((w) => !w.startsWith("tax year not detected") && !w.startsWith("taxpayer name not detected"));
    if (!f.taxYear) f.warnings.push("tax year not detected; set it before queueing");
    if (!f.clientId && !f.newClientName) f.warnings.push("taxpayer name not detected; pick a client before queueing");
    await this.save(stage);
    return this.toDto(stage);
  }

  /** Create the batch and one job per included file, move blobs, enqueue. */
  async queue(stageId: string, actor: Actor & { id: string }, ip: string | null, note?: string): Promise<{ batchId: string; jobIds: string[] }> {
    const stage = await this.load(stageId);
    if (stage.uploadedBy !== actor.id) throw notFound("Staging session expired or not found");
    const toQueue = stage.files.filter((f) => f.include && f.status === "ok" && f.role === "source");
    if (toQueue.length === 0) throw badRequest("No files selected to queue");
    for (const f of toQueue) {
      if (!f.taxYear) throw badRequest(`Set the tax year for ${f.originalName}`);
      if (!f.clientId && !f.newClientName) throw badRequest(`Pick a client for ${f.originalName}`);
    }

    const jobIds: string[] = [];
    const now = new Date();
    const batchId = await this.db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(batches)
        .values({ uploadedBy: actor.id, fileCount: toQueue.length, note: note?.slice(0, 2000) ?? null })
        .returning();
      await audit(tx as unknown as Db, { actor, action: "batch.create", target: { type: "batch", id: batch!.id }, ip, meta: { fileCount: toQueue.length } });

      const createdClients = new Map<string, string>(); // normalized -> id, so two files for one new client share it
      for (const f of toQueue) {
        let clientId = f.clientId;
        if (!clientId) {
          const norm = normalizeClientName(f.newClientName!);
          clientId = createdClients.get(norm) ?? null;
          if (!clientId) {
            const existing = await tx.select().from(clients).where(eq(clients.normalizedName, norm)).limit(1);
            if (existing[0]) clientId = existing[0].id;
          }
          if (!clientId) {
            const [c] = await tx.insert(clients).values({ name: f.newClientName!, normalizedName: norm }).returning();
            clientId = c!.id;
            createdClients.set(norm, clientId);
            await audit(tx as unknown as Db, { actor, action: "client.create", target: { type: "client", id: clientId }, ip, meta: { via: "upload" } });
          }
        }
        const prior = f.priorFileId ? stage.files.find((x) => x.fileId === f.priorFileId) : undefined;
        const [job] = await tx
          .insert(jobs)
          .values({
            status: "queued",
            clientId,
            batchId: batch!.id,
            uploadedBy: actor.id,
            taxYear: f.taxYear,
            software: f.detected?.software ?? null,
            form: f.detected?.form ?? "1040",
            sourceSha256: f.sha256,
            priorSha256: prior?.sha256 ?? null,
            note: f.note,
            pageCount: f.detected?.pageCount ?? null,
            queuedAt: now,
          })
          .returning();
        const jobId = job!.id;
        const moved = await this.storage.move(f.blob, jobId);
        await tx.insert(files).values({ id: f.fileId, jobId, kind: "source", path: moved.path, keyPath: moved.keyPath, sha256: f.sha256, size: f.size });
        if (prior) {
          const movedPrior = await this.storage.move(prior.blob, jobId);
          await tx.insert(files).values({ id: prior.fileId, jobId, kind: "prior", path: movedPrior.path, keyPath: movedPrior.keyPath, sha256: prior.sha256, size: prior.size });
        }
        await audit(tx as unknown as Db, {
          actor,
          action: "job.upload",
          target: { type: "job", id: jobId },
          ip,
          meta: { batch_id: batch!.id, client_id: clientId, sha256: f.sha256, prior_sha256: prior?.sha256 ?? null, tax_year: f.taxYear },
        });
        jobIds.push(jobId);
      }
      return batch!.id;
    });

    for (const id of jobIds) await this.enqueue(id);
    await this.redis.del(this.key(stage.id));
    await this.storage.removeScope(`staging/${stage.id}`);
    return { batchId, jobIds };
  }

  /** Delete staging blob directories whose Redis row has expired. Returns the count removed. */
  async sweepExpired(): Promise<number> {
    const dir = path.join(this.storage.blobsDir, "staging");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const id of entries) {
      if (await this.redis.exists(this.key(id))) continue;
      await this.storage.removeScope(`staging/${id}`);
      removed++;
    }
    return removed;
  }
}
