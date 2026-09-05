import type { FastifyInstance } from "fastify";
import { desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import type { ClientDto } from "@vibe-recap/shared";
import { clients, jobs, type Client } from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { normalizeClientName } from "../services/staging.js";
import { listJobSummaries } from "./jobs.js";

export function toClientDto(c: Client, jobCount?: number): ClientDto {
  return {
    id: c.id,
    name: c.name,
    externalRef: c.externalRef,
    retentionSourceDays: c.retentionSourceDays,
    retentionExtractionDays: c.retentionExtractionDays,
    retentionVideoDays: c.retentionVideoDays,
    legalHold: c.legalHold,
    notes: c.notes,
    createdAt: c.createdAt.toISOString(),
    ...(jobCount !== undefined ? { jobCount } : {}),
  };
}

const createBody = z.object({ name: z.string().min(1).max(200), externalRef: z.string().max(100).nullable().optional(), notes: z.string().max(2000).nullable().optional() });
const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  externalRef: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  retentionSourceDays: z.number().int().min(0).max(3650).nullable().optional(),
  retentionExtractionDays: z.number().int().min(0).max(3650).nullable().optional(),
  retentionVideoDays: z.number().int().min(0).max(3650).nullable().optional(),
  legalHold: z.boolean().optional(),
});

export async function clientRoutes(app: FastifyInstance) {
  app.get("/api/clients", { preHandler: requireRole("staff") }, async (req) => {
    const q = (req.query as { q?: string }).q?.trim();
    const rows = await app.db
      .select({ client: clients, jobCount: sql<number>`(select count(*) from jobs j where j.client_id = ${clients.id})` })
      .from(clients)
      .where(q ? ilike(clients.name, `%${q.replace(/[%_]/g, "")}%`) : undefined)
      .orderBy(clients.name)
      .limit(500);
    return { clients: rows.map((r) => toClientDto(r.client, Number(r.jobCount))) };
  });

  app.post("/api/clients", { preHandler: requireRole("staff") }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const normalizedName = normalizeClientName(body.name);
    const existing = await app.db.select().from(clients).where(eq(clients.normalizedName, normalizedName)).limit(1);
    if (existing[0]) throw conflict("A client with that name already exists", { clientId: existing[0].id });
    const [c] = await app.db.insert(clients).values({ name: body.name.trim(), normalizedName, externalRef: body.externalRef ?? null, notes: body.notes ?? null }).returning();
    await audit(app.db, { actor: actorOf(req), action: "client.create", target: { type: "client", id: c!.id }, ip: req.ip });
    reply.code(201);
    return toClientDto(c!);
  });

  app.get("/api/clients/:id", { preHandler: requireRole("staff") }, async (req) => {
    const { id } = req.params as { id: string };
    const [c] = await app.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    if (!c) throw notFound("Client not found");
    const jobList = await listJobSummaries(app.db, { clientId: id, limit: 200 });
    return { client: toClientDto(c, jobList.length), jobs: jobList };
  });

  app.patch("/api/clients/:id", { preHandler: requireRole("preparer") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = patchBody.parse(req.body);
    const [c] = await app.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    if (!c) throw notFound("Client not found");
    const isAdmin = req.auth!.user.role === "admin";
    if (body.legalHold !== undefined && !isAdmin) throw forbidden("Only an admin can change legal hold");
    const retentionTouched = ["retentionSourceDays", "retentionExtractionDays", "retentionVideoDays"].some((k) => k in body);
    if (retentionTouched && !isAdmin) throw forbidden("Only an admin can change retention overrides");
    const patch: Partial<Client> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      patch.name = body.name.trim();
      patch.normalizedName = normalizeClientName(body.name);
    }
    for (const k of ["externalRef", "notes", "retentionSourceDays", "retentionExtractionDays", "retentionVideoDays", "legalHold"] as const) {
      if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    }
    const [updated] = await app.db.update(clients).set(patch).where(eq(clients.id, id)).returning();
    const changed = Object.keys(body);
    await audit(app.db, {
      actor: actorOf(req),
      action: body.legalHold !== undefined && changed.length === 1 ? (body.legalHold ? "client.legal_hold_set" : "client.legal_hold_cleared") : "client.update",
      target: { type: "client", id },
      ip: req.ip,
      meta: { fields: changed },
    });
    if (!updated) throw badRequest("Update failed");
    return toClientDto(updated);
  });

  void desc;
  void jobs;
}
