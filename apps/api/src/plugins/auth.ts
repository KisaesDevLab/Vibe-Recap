import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { roleAtLeast, type Role } from "@vibe-recap/shared";
import { SESSION_COOKIE, loadSession, type SessionPolicy, type SessionWithUser } from "../auth/session.js";
import { forbidden, unauthorized } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: SessionWithUser | null;
  }
  interface FastifyContextConfig {
    /** Set false on routes that legitimately have no session yet (login, setup). */
    csrf?: boolean;
    /** Set false to allow anonymous access. Default: authentication required under /api. */
    auth?: boolean;
  }
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AuthPluginOptions {
  policy: SessionPolicy;
}

async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions) {
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (req) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid) return;
    req.auth = await loadSession(app.db, sid, opts.policy);
  });

  // Origin allow-list (Vibe Appliance item 2): when ALLOWED_ORIGIN is set, state-changing
  // browser requests must carry one of the listed origins. Comma-separated; blank = same-origin
  // only, which the SameSite=Strict cookie already enforces.
  const allowedOrigins = app.config.ALLOWED_ORIGIN.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  app.addHook("onRequest", async (req, reply) => {
    if (!allowedOrigins.length || !STATE_CHANGING.has(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients (no Origin header) are governed by the session + CSRF checks
    if (!allowedOrigins.includes(origin.replace(/\/$/, ""))) {
      reply.code(403);
      throw forbidden("Origin not allowed");
    }
  });

  // CSRF: double-submit header must equal the per-session token on every state-changing request.
  app.addHook("preHandler", async (req, reply) => {
    if (!STATE_CHANGING.has(req.method)) return;
    if (req.routeOptions.config.csrf === false) return;
    if (!req.auth) return; // unauthenticated requests are rejected by requireAuth below
    const header = req.headers["x-csrf-token"];
    if (typeof header !== "string" || header !== req.auth.session.csrfToken) {
      reply.code(403);
      throw forbidden("CSRF token missing or invalid");
    }
  });

  // Everything under /api requires a session unless the route opts out.
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    if (req.routeOptions.config.auth === false) return;
    if (!req.auth) throw unauthorized();
  });
}

export const authPluginRegistered = fp(authPlugin, { name: "recap-auth" });

export function requireRole(min: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.auth) throw unauthorized();
    if (!roleAtLeast(req.auth.user.role, min)) throw forbidden(`Requires ${min} role`);
  };
}

export function currentUser(req: FastifyRequest) {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}

export function actorOf(req: FastifyRequest) {
  const u = req.auth?.user;
  return u ? { id: u.id, label: u.email } : { id: null, label: "anonymous" };
}
