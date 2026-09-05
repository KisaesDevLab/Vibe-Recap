import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { clients } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { retentionReport, runPurge } from "../services/purge.js";
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
      preview: result.candidates.slice(0, 500).map((c) => ({ jobId: c.job.id, clientId: c.job.clientId, kind: c.file.kind, reason: c.reason })),
    };
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
