import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CookieSerializeOptions } from "@fastify/cookie";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { VOICE_CODES, type MeResponse, type UserDto } from "@vibe-recap/shared";
import { users, type User } from "../db/schema.js";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE, createSession, destroySession, destroyOtherSessions, destroyUserSessions } from "../auth/session.js";
import { badRequest, locked, notFound, unauthorized } from "../errors.js";
import { audit, ANONYMOUS } from "../services/audit.js";
import { currentUser } from "../plugins/auth.js";
import { consumeResetToken, createResetToken, peekResetToken, revokeResetTokens, RESET_TTL_S } from "../auth/reset.js";
import { emailConfig, publicUrl, sendEmail, trySendEmail } from "../services/email.js";
import { passwordChangedEmail, passwordResetEmail } from "../services/email-templates.js";
import { getSetting } from "../services/settings.js";

export function cookieOptions(app: FastifyInstance): CookieSerializeOptions {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: app.config.COOKIE_SECURE,
    maxAge: app.sessionPolicy.absoluteDays * 24 * 3600,
  };
}

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    mustChangePassword: u.mustChangePassword,
    voice: u.voice,
  };
}

/** Email a one-hour, single-use reset link to a user. Shared by self-service and the admin button. */
export async function issueResetLink(app: FastifyInstance, user: User, req: FastifyRequest): Promise<void> {
  const token = await createResetToken(app.redis, user.id);
  const url = `${await publicUrl(app, req)}/reset-password/${token}`;
  const firmName = await getSetting(app.db, "firm_name");
  await sendEmail(app, user.email, "password_reset", passwordResetEmail({ firmName, url, ttlMinutes: RESET_TTL_S / 60 }));
}

const loginBody = z.object({ email: z.string().max(200), password: z.string().max(512) });
const changePasswordBody = z.object({ currentPassword: z.string().max(512), newPassword: z.string().max(512) });
const preferencesBody = z.object({ voice: z.enum(VOICE_CODES as [string, ...string[]]).nullable().optional() });

// A dummy hash so a login for an unknown email costs the same as a wrong password.
let dummyHash: string | null = null;

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/api/auth/login",
    { config: { auth: false, csrf: false, rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = loginBody.parse(req.body);
      const email = body.email.trim().toLowerCase();
      const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1);
      const now = new Date();

      if (user?.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
        await audit(app.db, {
          actor: ANONYMOUS,
          action: "auth.login_locked",
          target: { type: "user", id: user.id },
          ip: req.ip,
        });
        throw locked("Account is temporarily locked after too many failed attempts");
      }

      dummyHash ??= await hashPassword("dummy-password-for-timing-only");
      let ok = false;
      if (user && !user.disabled) ok = await verifyPassword(user.passwordHash, body.password);
      else await verifyPassword(dummyHash, body.password);

      if (!ok || !user) {
        if (user) {
          const failed = user.failedLogins + 1;
          const lockedUntil =
            failed >= app.config.LOGIN_MAX_FAILURES
              ? new Date(now.getTime() + app.config.LOGIN_LOCKOUT_MINUTES * 60_000)
              : null;
          await app.db
            .update(users)
            .set({ failedLogins: lockedUntil ? 0 : failed, lockedUntil, updatedAt: now })
            .where(eq(users.id, user.id));
          await audit(app.db, {
            actor: ANONYMOUS,
            action: lockedUntil ? "auth.lockout" : "auth.login_failed",
            target: { type: "user", id: user.id },
            ip: req.ip,
            meta: { failed },
          });
        } else {
          await audit(app.db, { actor: ANONYMOUS, action: "auth.login_failed", ip: req.ip, meta: { unknownUser: true } });
        }
        throw unauthorized("Invalid email or password");
      }

      await app.db
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now })
        .where(eq(users.id, user.id));
      const session = await createSession(app.db, user.id, app.sessionPolicy, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await audit(app.db, {
        actor: { id: user.id, label: user.email },
        action: "auth.login",
        target: { type: "user", id: user.id },
        ip: req.ip,
      });
      reply.setCookie(SESSION_COOKIE, session.id, cookieOptions(app));
      const me: MeResponse = { user: toUserDto(user), csrfToken: session.csrfToken };
      return me;
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const user = currentUser(req);
    await destroySession(app.db, req.auth!.session.id);
    await audit(app.db, {
      actor: { id: user.id, label: user.email },
      action: "auth.logout",
      target: { type: "user", id: user.id },
      ip: req.ip,
    });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req): Promise<MeResponse> => {
    const user = currentUser(req);
    return { user: toUserDto(user), csrfToken: req.auth!.session.csrfToken };
  });

  /** Personal preferences. The narration voice a user picks here is used for the recaps they
   * upload; clearing it falls back to the firm default under Settings > General. */
  app.put("/api/auth/preferences", async (req) => {
    const user = currentUser(req);
    const body = preferencesBody.parse(req.body);
    const voice = body.voice ?? null;
    await app.db.update(users).set({ voice, updatedAt: sql`now()` }).where(eq(users.id, user.id));
    return { voice };
  });

  app.post("/api/auth/change-password", async (req) => {
    const user = currentUser(req);
    const body = changePasswordBody.parse(req.body);
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw unauthorized("Current password is incorrect");
    }
    const reason = checkPasswordPolicy(body.newPassword);
    if (reason) throw badRequest(reason);
    await app.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: false, updatedAt: sql`now()` })
      .where(eq(users.id, user.id));
    // Every other session for this user is invalidated; the current one continues.
    await destroyOtherSessions(app.db, user.id, req.auth!.session.id);
    await revokeResetTokens(app.redis, user.id);
    await audit(app.db, {
      actor: { id: user.id, label: user.email },
      action: "user.password_change",
      target: { type: "user", id: user.id },
      ip: req.ip,
    });
    await trySendEmail(app, user.email, "password_changed", passwordChangedEmail({ firmName: await getSetting(app.db, "firm_name"), url: await publicUrl(app, req) }));
    return { ok: true };
  });

  // ---- Self-service password reset by email (Q48). Public, rate limited, never reveals whether
  // an account exists. Only available once an admin has configured outgoing email.

  app.get("/api/auth/password-reset/status", { config: { auth: false } }, async () => {
    const cfg = await emailConfig(app);
    return { enabled: cfg.enabled };
  });

  app.post(
    "/api/auth/forgot-password",
    { config: { auth: false, csrf: false, rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req) => {
      const body = z.object({ email: z.string().max(200) }).parse(req.body);
      const cfg = await emailConfig(app);
      if (!cfg.enabled) throw badRequest("Password reset by email is not enabled on this installation. Ask an administrator to reset your password.");
      const email = body.email.trim().toLowerCase();
      const [user] = await app.db.select().from(users).where(eq(users.email, email)).limit(1);
      if (user && !user.disabled) {
        try {
          await issueResetLink(app, user, req);
          await audit(app.db, { actor: ANONYMOUS, action: "auth.password_reset_requested", target: { type: "user", id: user.id }, ip: req.ip });
        } catch (err) {
          // The answer stays generic so the caller cannot tell a send failure from an unknown address.
          req.log.warn({ err: (err as Error).message }, "password reset email failed");
          await audit(app.db, { actor: ANONYMOUS, action: "auth.password_reset_email_failed", target: { type: "user", id: user.id }, ip: req.ip, meta: { error: (err as Error).message.slice(0, 200) } });
        }
      } else {
        await audit(app.db, { actor: ANONYMOUS, action: "auth.password_reset_requested", ip: req.ip, meta: { unknownUser: true } });
      }
      return { ok: true, message: "If an account exists for that address, a reset link is on its way. It expires in one hour." };
    },
  );

  app.get("/api/auth/reset-password/:token", { config: { auth: false, rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { token } = req.params as { token: string };
    const hit = await peekResetToken(app.redis, token);
    const [u] = hit ? await app.db.select().from(users).where(eq(users.id, hit.userId)).limit(1) : [];
    if (!u || u.disabled) throw notFound("This reset link is invalid or has expired");
    return { email: u.email, name: u.name };
  });

  app.post(
    "/api/auth/reset-password/:token",
    { config: { auth: false, csrf: false, rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const { token } = req.params as { token: string };
      const body = z.object({ password: z.string().max(512) }).parse(req.body);
      const reason = checkPasswordPolicy(body.password);
      if (reason) throw badRequest(reason);
      const hit = await peekResetToken(app.redis, token);
      const [u] = hit ? await app.db.select().from(users).where(eq(users.id, hit.userId)).limit(1) : [];
      if (!u || u.disabled) throw notFound("This reset link is invalid or has expired");
      // Consume first so two submissions of the same link cannot both succeed.
      if (!(await consumeResetToken(app.redis, token))) throw notFound("This reset link is invalid or has expired");
      await app.db
        .update(users)
        .set({ passwordHash: await hashPassword(body.password), mustChangePassword: false, failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, u.id));
      await destroyUserSessions(app.db, u.id);
      await audit(app.db, { actor: { id: u.id, label: u.email }, action: "user.password_reset_self", target: { type: "user", id: u.id }, ip: req.ip });
      await trySendEmail(app, u.email, "password_changed", passwordChangedEmail({ firmName: await getSetting(app.db, "firm_name"), url: await publicUrl(app, req) }));
      return { ok: true };
    },
  );
}
