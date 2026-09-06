import type { FastifyInstance } from "fastify";
import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { ROLES, type Role, type UserDto } from "@vibe-recap/shared";
import { users } from "../db/schema.js";
import { checkPasswordPolicy, hashPassword } from "../auth/password.js";
import { destroyUserSessions, newToken } from "../auth/session.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { issueResetLink, toUserDto } from "./auth.js";
import { emailEnabled, publicUrl, trySendEmail } from "../services/email.js";
import { inviteEmail } from "../services/email-templates.js";
import { getSetting } from "../services/settings.js";

const INVITE_TTL_S = 24 * 3600;

const createBody = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  role: z.enum(ROLES),
  /** Either a temporary password (user must change it) or an invite link. */
  tempPassword: z.string().max(512).optional(),
  /** Email the invite link to the new user when outgoing email is configured (default true). */
  sendEmail: z.boolean().optional(),
});

async function adminCount(app: FastifyInstance, excludeId?: string): Promise<number> {
  const [row] = await app.db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.disabled, false), excludeId ? ne(users.id, excludeId) : undefined));
  return row?.n ?? 0;
}

export async function userRoutes(app: FastifyInstance) {
  app.get("/api/users", { preHandler: requireRole("admin") }, async () => {
    const rows = await app.db.select().from(users).orderBy(users.email);
    return {
      users: rows.map((u) => ({
        ...toUserDto(u),
        mustChangePassword: u.mustChangePassword,
        passkeys: 0,
        totp: false,
        lockedUntil: u.lockedUntil?.toISOString() ?? null,
      })),
    };
  });

  app.post("/api/users", { preHandler: requireRole("admin") }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const email = body.email.toLowerCase();
    const existing = await app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) throw conflict("A user with that email already exists");
    let inviteUrl: string | null = null;
    let emailed = false;
    let emailError: string | null = null;
    let passwordHash: string;
    if (body.tempPassword) {
      const reason = checkPasswordPolicy(body.tempPassword);
      if (reason) throw badRequest(reason);
      passwordHash = await hashPassword(body.tempPassword);
    } else {
      passwordHash = await hashPassword(newToken(32)); // unusable until the invite is accepted
    }
    const [u] = await app.db
      .insert(users)
      .values({ email, name: body.name, role: body.role, passwordHash, mustChangePassword: !!body.tempPassword })
      .returning();
    if (!body.tempPassword) {
      const token = newToken(32);
      await app.redis.set(`invite:${token}`, JSON.stringify({ userId: u!.id }), "EX", INVITE_TTL_S);
      inviteUrl = `/invite/${token}`;
      if (body.sendEmail !== false && (await emailEnabled(app))) {
        const firmName = await getSetting(app.db, "firm_name");
        const r = await trySendEmail(app, email, "invite", inviteEmail({ firmName, url: `${await publicUrl(app, req)}${inviteUrl}`, name: body.name, role: body.role, ttlHours: INVITE_TTL_S / 3600 }));
        emailed = r.sent;
        emailError = r.error;
      }
    }
    await audit(app.db, { actor: actorOf(req), action: "user.create", target: { type: "user", id: u!.id }, ip: req.ip, meta: { role: body.role, via: inviteUrl ? "invite" : "temp_password", emailed } });
    reply.code(201);
    return { user: toUserDto(u!), inviteUrl, emailed, emailError };
  });

  /** Admin: email the user a one-hour reset link instead of handing over a temporary password (Q48). */
  app.post("/api/users/:id/send-reset-link", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const [u] = await app.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw notFound("User not found");
    if (u.disabled) throw badRequest("The user is disabled; enable the account first");
    if (!(await emailEnabled(app))) throw badRequest("Outgoing email is not configured (Settings > Email)");
    try {
      await issueResetLink(app, u, req);
    } catch (err) {
      throw badRequest(`Could not send the reset link: ${(err as Error).message}`);
    }
    await audit(app.db, { actor: actorOf(req), action: "user.password_reset_link_sent", target: { type: "user", id }, ip: req.ip });
    return { ok: true };
  });

  app.patch("/api/users/:id", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional(), name: z.string().min(1).max(120).optional() }).parse(req.body);
    const [u] = await app.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw notFound("User not found");
    const demoting = (body.role !== undefined && body.role !== "admin" && u.role === "admin") || (body.disabled === true && u.role === "admin" && !u.disabled);
    if (demoting && (await adminCount(app, id)) === 0) throw badRequest("Cannot demote or disable the last active admin");
    const patch: Partial<typeof u> = { updatedAt: new Date() };
    if (body.role !== undefined) patch.role = body.role as Role;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (body.name !== undefined) patch.name = body.name;
    const [updated] = await app.db.update(users).set(patch).where(eq(users.id, id)).returning();
    if (body.disabled) await destroyUserSessions(app.db, id);
    await audit(app.db, { actor: actorOf(req), action: body.disabled ? "user.disable" : body.disabled === false ? "user.enable" : body.role ? "user.role_change" : "user.update", target: { type: "user", id }, ip: req.ip, meta: { role: body.role, disabled: body.disabled } });
    return toUserDto(updated!);
  });

  app.post("/api/users/:id/reset-password", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ tempPassword: z.string().max(512) }).parse(req.body);
    const reason = checkPasswordPolicy(body.tempPassword);
    if (reason) throw badRequest(reason);
    const [u] = await app.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw notFound("User not found");
    await app.db.update(users).set({ passwordHash: await hashPassword(body.tempPassword), mustChangePassword: true, failedLogins: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, id));
    await destroyUserSessions(app.db, id);
    await audit(app.db, { actor: actorOf(req), action: "user.password_reset", target: { type: "user", id }, ip: req.ip });
    return { ok: true };
  });

  app.post("/api/users/:id/force-logout", { preHandler: requireRole("admin") }, async (req) => {
    const { id } = req.params as { id: string };
    const n = await destroyUserSessions(app.db, id);
    await audit(app.db, { actor: actorOf(req), action: "user.force_logout", target: { type: "user", id }, ip: req.ip, meta: { sessions: n } });
    return { ok: true, sessions: n };
  });

  /** Invite acceptance: public, single use, 24 h. */
  app.get("/api/invite/:token", { config: { auth: false } }, async (req) => {
    const { token } = req.params as { token: string };
    const raw = await app.redis.get(`invite:${token}`);
    if (!raw) throw notFound("Invite link is invalid or has expired");
    const { userId } = JSON.parse(raw) as { userId: string };
    const [u] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw notFound("Invite link is invalid or has expired");
    return { email: u.email, name: u.name, role: u.role };
  });

  app.post("/api/invite/:token", { config: { auth: false, csrf: false, rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { token } = req.params as { token: string };
    const body = z.object({ password: z.string().max(512) }).parse(req.body);
    const raw = await app.redis.get(`invite:${token}`);
    if (!raw) throw notFound("Invite link is invalid or has expired");
    const reason = checkPasswordPolicy(body.password);
    if (reason) throw badRequest(reason);
    const { userId } = JSON.parse(raw) as { userId: string };
    await app.db.update(users).set({ passwordHash: await hashPassword(body.password), mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, userId));
    await app.redis.del(`invite:${token}`);
    await audit(app.db, { actor: { id: userId, label: "invitee" }, action: "user.invite_accepted", target: { type: "user", id: userId }, ip: req.ip });
    return { ok: true };
  });

  void (0 as unknown as UserDto);
}
