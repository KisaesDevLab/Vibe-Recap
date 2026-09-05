import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { auditEvents, jobs } from "../db/schema.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";

const query = z.object({
  actor: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  clientId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function conditions(q: z.infer<typeof query>): SQL[] {
  const conds: SQL[] = [];
  if (q.actor) conds.push(ilike(auditEvents.actorLabel, `%${q.actor.replace(/[%_]/g, "")}%`));
  if (q.action) conds.push(ilike(auditEvents.action, `${q.action.replace(/[%_]/g, "")}%`));
  if (q.jobId) conds.push(and(eq(auditEvents.targetType, "job"), eq(auditEvents.targetId, q.jobId))!);
  if (q.clientId) {
    conds.push(
      or(
        and(eq(auditEvents.targetType, "client"), eq(auditEvents.targetId, q.clientId)),
        and(eq(auditEvents.targetType, "job"), sql`${auditEvents.targetId} in (select id::text from jobs where client_id = ${q.clientId})`),
      )!,
    );
  }
  if (q.from) conds.push(gte(auditEvents.at, new Date(q.from)));
  if (q.to) conds.push(lte(auditEvents.at, new Date(q.to)));
  return conds;
}

export async function auditRoutes(app: FastifyInstance) {
  app.get("/api/audit", { preHandler: requireRole("admin") }, async (req) => {
    const q = query.parse(req.query);
    const conds = conditions(q);
    const where = conds.length ? and(...conds) : undefined;
    const [total] = await app.db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(where);
    const rows = await app.db
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      total: Number(total?.n ?? 0),
      page: q.page,
      pageSize: q.pageSize,
      events: rows.map((r) => ({ id: r.id, at: r.at.toISOString(), actor: r.actorLabel, actorId: r.actorId, action: r.action, targetType: r.targetType, targetId: r.targetId, ip: r.ip, meta: r.meta })),
      retentionNote: "Audit events are never purged by policy. Export and truncate is a manual admin action.",
    };
  });

  app.get("/api/audit/export.csv", { preHandler: requireRole("admin") }, async (req, reply) => {
    const q = query.parse({ ...(req.query as object), page: 1, pageSize: 200 });
    const conds = conditions(q);
    const rows = await app.db
      .select()
      .from(auditEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(auditEvents.id)
      .limit(100_000);
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["id,at,actor,action,target_type,target_id,ip,meta"];
    for (const r of rows) lines.push([r.id, r.at.toISOString(), r.actorLabel, r.action, r.targetType ?? "", r.targetId ?? "", r.ip ?? "", JSON.stringify(r.meta)].map(esc).join(","));
    await audit(app.db, { actor: actorOf(req), action: "audit.export", ip: req.ip, meta: { rows: rows.length } });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="audit-log.csv"');
    return lines.join("\n") + "\n";
  });

  void jobs;
}
