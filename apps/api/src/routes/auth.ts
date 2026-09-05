import type { FastifyInstance } from "fastify";
import type { CookieSerializeOptions } from "@fastify/cookie";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { MeResponse, UserDto } from "@vibe-recap/shared";
import { users, type User } from "../db/schema.js";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE, createSession, destroySession, destroyOtherSessions } from "../auth/session.js";
import { badRequest, locked, unauthorized } from "../errors.js";
import { audit, ANONYMOUS } from "../services/audit.js";
import { currentUser } from "../plugins/auth.js";

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
  };
}

const loginBody = z.object({ email: z.string().max(200), password: z.string().max(512) });
const changePasswordBody = z.object({ currentPassword: z.string().max(512), newPassword: z.string().max(512) });

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
    await audit(app.db, {
      actor: { id: user.id, label: user.email },
      action: "user.password_change",
      target: { type: "user", id: user.id },
      ip: req.ip,
    });
    return { ok: true };
  });
}
