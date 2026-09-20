/**
 * Single sign-on through Vibe Auth (Q57).
 *
 * `@kisaesdevlab/vibe-auth` speaks OIDC (authorization code + PKCE) to the firm's identity
 * provider and serves `/auth/*`. It owns no session and sets no cookie: when a sign-in succeeds
 * it calls the `SessionAdapter` below, and what comes out is the same `sessions` row, the same
 * per-session CSRF token and the same `recap_sid` cookie a local sign-in produces. Nothing
 * downstream can tell the two apart except by `sessions.oidc_issuer`.
 *
 * Off until configured: with `VIBE_AUTH_MODE` unset the mode is `local` and the only thing
 * `/auth/*` answers usefully is `GET /auth/status`.
 *
 * `/auth/*` sits outside `/api/`, so the blanket "session required" hook does not cover it (the
 * sign-in routes must be anonymous). The other global hooks do apply, which is wanted: the
 * session is loaded for every request, and a state-changing call that carries a session
 * (`PUT /auth/settings`) must pass the Origin allow-list and the CSRF check like any other. The
 * identity provider's back-channel logout POST carries neither cookie nor Origin and passes.
 */
import formbody from "@fastify/formbody";
import {
  createPgStores,
  createVibeAuth,
  vibeAuthFastify,
  type SecretWrap,
  type SessionAdapter,
  type SessionIdentity,
  type VibeAuth,
  type VibeUser,
} from "@kisaesdevlab/vibe-auth";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { users } from "../db/schema.js";
import { SESSION_COOKIE, createSession, destroySession, destroySessionsByIdentity } from "../auth/session.js";
import { cookieOptions } from "../routes/auth.js";
import { ADMIN_ROLE, DEFAULT_ROLE_MAP, PRODUCT_ROLES, createVibeAuthAudit, createVibeAuthUsers } from "./vibeAuthUsers.js";

declare module "fastify" {
  interface FastifyInstance {
    vibeAuth: VibeAuth;
  }
}

/**
 * The package is framework-neutral and types its adapter arguments as Express objects. Under
 * `vibeAuthFastify` what actually arrives is the Fastify request and reply, so they are re-typed
 * here, once, rather than cast at each use.
 */
const asRequest = (req: unknown): FastifyRequest => req as FastifyRequest;
const asReply = (res: unknown): FastifyReply => res as FastifyReply;

/**
 * The package's stores run plain `$1` SQL and hand over JS values (Date, boolean, string[]).
 * postgres.js only serializes those by type inside its tagged template; through `unsafe()` a
 * Date throws. Everything goes over as text instead and Postgres casts it to the column's type,
 * which is what the untyped parameter asks for anyway.
 */
export function textParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `{${value.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
  return String(value);
}

function sessionAdapter(app: FastifyInstance, secretWrap: SecretWrap): SessionAdapter {
  return {
    async create(req, res, user: VibeUser, identity: SessionIdentity) {
      const request = asRequest(req);
      const now = new Date();
      const session = await createSession(app.db, user.id, app.sessionPolicy, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        oidc: {
          issuer: identity.issuer,
          subject: identity.subject,
          sid: identity.sid ?? null,
          idTokenWrapped: identity.idToken ? await secretWrap.wrap(identity.idToken) : null,
        },
      });
      await app.db.update(users).set({ lastLoginAt: now, updatedAt: now }).where(eq(users.id, user.id));
      // The SPA picks the CSRF token up from GET /api/auth/me on boot, as it does after a reload.
      void asReply(res).setCookie(SESSION_COOKIE, session.id, cookieOptions(app));
    },

    async destroy(req, res) {
      const current = asRequest(req).auth;
      if (current) await destroySession(app.db, current.session.id);
      void asReply(res).clearCookie(SESSION_COOKIE, { path: "/" });
    },

    async currentUserId(req) {
      return asRequest(req).auth?.user.id ?? null;
    },

    async currentIdentity(req) {
      const s = asRequest(req).auth?.session;
      if (!s?.oidcIssuer || !s.oidcSubject) return null;
      let idToken: string | undefined;
      try {
        idToken = s.oidcIdTokenWrapped ? await secretWrap.unwrap(s.oidcIdTokenWrapped) : undefined;
      } catch {
        // A rotated master key. Sign-out still works; the identity provider just gets no hint.
        idToken = undefined;
      }
      return {
        issuer: s.oidcIssuer,
        subject: s.oidcSubject,
        ...(s.oidcSid ? { sid: s.oidcSid } : {}),
        ...(idToken ? { idToken } : {}),
      };
    },

    async destroyByIdentity(identity) {
      return destroySessionsByIdentity(app.db, identity);
    },
  };
}

export interface VibeAuthPluginOptions {
  /** Where `VIBE_AUTH_MODE` and `VIBE_OIDC_*` are read from. Tests pass their own. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the engine, mounts `/auth/*` and starts it. Call after the cookie plugin and the auth
 * plugin, before the app's own routes. The one thing `start()` throws for is `oidc_only` without
 * a working break-glass account; that aborts startup with its own message, by design.
 */
export async function registerVibeAuth(app: FastifyInstance, opts: VibeAuthPluginOptions = {}): Promise<VibeAuth> {
  // Same key as the documents: the client secret and ID tokens are wrapped to the master key.
  const secretWrap: SecretWrap = {
    wrap: (plaintext) => app.storage.wrapSecret(plaintext),
    unwrap: (wrapped) => app.storage.unwrapSecret(wrapped),
  };

  const stores = createPgStores({
    query: async (sql, params) => [...(await app.db.$client.unsafe(sql, (params ?? []).map(textParam) as never[]))] as Array<Record<string, unknown>>,
  });

  const auth = createVibeAuth({
    product: {
      slug: "vibe-recap",
      name: "Vibe Recap",
      roles: { roles: [...PRODUCT_ROLES], adminRole: ADMIN_ROLE, defaultRoleMap: DEFAULT_ROLE_MAP },
    },
    users: createVibeAuthUsers(app.db),
    session: sessionAdapter(app, secretWrap),
    identities: stores.identities,
    settings: stores.settings,
    // Inert here (sessions are rows, and back-channel logout deletes them), but the package
    // writes it when present and the table exists, so the record is complete.
    revocations: stores.revocations,
    secretWrap,
    audit: createVibeAuthAudit(app.db, (msg) => app.log.error(msg)),
    env: opts.env ?? process.env,
    // Recap is served at the root of its own origin (rootServedOnly). Redirect URIs come from
    // VIBE_OIDC_PUBLIC_URL, never from this.
    basePath: "",
    loginPath: "/login",
    breakglassLoginPath: "/login/local",
    defaultReturnTo: "/",
    trustProxy: app.config.TRUST_PROXY,
    syncRoles: true,
    logger: {
      info: (msg, meta) => app.log.info(meta ?? {}, msg),
      warn: (msg, meta) => app.log.warn(meta ?? {}, msg),
      error: (msg, meta) => app.log.error(meta ?? {}, msg),
    },
  });

  // The identity provider sends the back-channel logout token urlencoded.
  await app.register(formbody);
  await app.register(vibeAuthFastify, { auth });
  app.decorate("vibeAuth", auth);

  await auth.start();
  app.addHook("onClose", async () => auth.stop());
  return auth;
}
