import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { clients, jobs } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { retentionReport, runPurge } from "../services/purge.js";
import { heldJobIds } from "./feedback.js";
import { getAllSettings, setSetting, type SettingKey } from "../services/settings.js";

const RETENTION_KEYS = ["retention_source_days", "retention_extraction_days", "retention_video_days", "retention_failed_days"] as const satisfies readonly SettingKey[];

const retentionBody = z.object({
  retention_source_days: z.number().int().min(0).max(3650).optional(),
  retention_extraction_days: z.number().int().min(0).max(3650).optional(),
  retention_video_days: z.number().int().min(0).max(3650).optional(),
  retention_failed_days: z.number().int().min(0).max(3650).optional(),
});

export async function retentionRoutes(app: FastifyInstance) {
  app.get("/api/settings/retention", { preHandler: requireRole("admin") }, async () => {
    const s = await getAllSettings(app.db);
    const report = await retentionReport(app, 7);
    return { settings: Object.fromEntries(RETENTION_KEYS.map((k) => [k, s[k]])), report };
  });

  app.put("/api/settings/retention", { preHandler: requireRole("admin") }, async (req) => {
    const body = retentionBody.parse(req.body);
    const user = req.auth!.user;
    const changed: string[] = [];
    for (const k of RETENTION_KEYS) {
      const v = body[k];
      if (v === undefined) continue;
      await setSetting(app.db, k, v, user.id);
      changed.push(k);
    }
    await audit(app.db, { actor: actorOf(req), action: "settings.update", target: { type: "settings", id: "retention" }, ip: req.ip, meta: { keys: changed, values: Object.fromEntries(changed.map((k) => [k, body[k as keyof typeof body]])) } });
    const s = await getAllSettings(app.db);
    return { settings: Object.fromEntries(RETENTION_KEYS.map((k) => [k, s[k]])) };
  });

  app.get("/api/settings/retention/report.csv", { preHandler: requireRole("admin") }, async (req, reply) => {
    const dry = await runPurge(app, { dryRun: true, now: new Date(Date.now() + 7 * 86400_000) });
    const lines = ["job_id,client_id,kind,file_sha256,reason"];
    for (const c of dry.candidates) lines.push([c.job.id, c.job.clientId, c.file.kind, c.file.sha256, JSON.stringify(c.reason)].join(","));
    await audit(app.db, { actor: actorOf(req), action: "settings.retention_report", ip: req.ip, meta: { rows: dry.candidates.length } });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="retention-due-7d.csv"');
    return lines.join("\n") + "\n";
  });

  /** Admin "Purge now": dry-run preview by default; `confirm: true` runs the same code path as the hourly job. */
  app.post("/api/settings/retention/purge-now", { preHandler: requireRole("admin") }, async (req) => {
    const body = z.object({ confirm: z.boolean().optional() }).parse(req.body ?? {});
    const actor = actorOf(req);
    const result = await runPurge(app, { dryRun: !body.confirm, actor, ip: req.ip });
    if (body.confirm) {
      await audit(app.db, { actor, action: "retention.purge_now", ip: req.ip, meta: { purged_files: result.purgedFiles, purged_jobs: result.purgedJobs } });
    }
    return {
      dryRun: result.dryRun,
      purgedFiles: result.purgedFiles,
      purgedJobs: result.purgedJobs,
      skippedLegalHold: result.skippedLegalHold,
      skippedFeedbackHold: result.skippedFeedbackHold,
      preview: result.candidates.slice(0, 500).map((c) => ({ jobId: c.job.id, clientId: c.job.clientId, kind: c.file.kind, reason: c.reason })),
    };
  });

  /** Purge one job's files, now. Admin types the job's short id to confirm; the same code path,
   * the same audit row per file, and the same holds as the hourly run. */
  app.post("/api/jobs/:id/purge-now", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ confirmJobId: z.string().max(80) }).parse(req.body);
    const [row] = await app.db
      .select({ job: jobs, client: clients })
      .from(jobs)
      .innerJoin(clients, eq(clients.id, jobs.clientId))
      .where(eq(jobs.id, id))
      .limit(1);
    if (!row) throw notFound("Job not found");
    const typed = body.confirmJobId.trim().toLowerCase();
    if (typed !== id.toLowerCase() && typed !== id.slice(0, 8).toLowerCase()) throw badRequest("Type the job id shown above to confirm");
    if (row.job.status === "purged") throw badRequest("This job has already been purged");
    if (row.job.status === "queued" || row.job.status === "processing") throw badRequest("The worker is still using this job's files; wait for it to finish or fail");
    if (row.client.legalHold) throw badRequest("The client is on legal hold; release the hold first");
    if ((await heldJobIds(app.db, new Date())).has(id)) throw badRequest("This job is held for quality review; dismiss the feedback on Settings > Quality first");
    const actor = actorOf(req);
    const result = await runPurge(app, { actor, jobId: id, everything: true, ip: req.ip });
    await audit(app.db, { actor, action: "job.purge_now", target: { type: "job", id }, ip: req.ip, meta: { purged_files: result.purgedFiles, purged: result.purgedJobs > 0 } });
    return { purgedFiles: result.purgedFiles, purged: result.purgedJobs > 0 };
  });

  /** Purge every file of one client's jobs. Admin types the client name to confirm. */
  app.post("/api/clients/:id/purge-now", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ confirmName: z.string().max(200) }).parse(req.body);
    const [client] = await app.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    if (!client) throw notFound("Client not found");
    if (client.legalHold) throw badRequest("Client is on legal hold; release the hold first");
    if (body.confirmName.trim() !== client.name) throw badRequest("Type the client name exactly to confirm");
    const actor = actorOf(req);
    const result = await runPurge(app, { actor, clientId: id, everything: true, ip: req.ip });
    await audit(app.db, { actor, action: "client.purge_now", target: { type: "client", id }, ip: req.ip, meta: { purged_files: result.purgedFiles, purged_jobs: result.purgedJobs } });
    return { purgedFiles: result.purgedFiles, purgedJobs: result.purgedJobs };
  });
}
