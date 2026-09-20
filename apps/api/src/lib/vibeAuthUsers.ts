/**
 * Vibe Auth user adapter and audit sink (Q57).
 *
 * `@kisaesdevlab/vibe-auth` owns the OIDC protocol; this file is the part of single sign-on that
 * knows what a Recap account is. The break-glass CLI (`src/vibeAuthAdapter.ts`) loads it on its
 * own, so it must not import the HTTP server.
 *
 * Two kinds of account are created here and they are deliberately different:
 *
 * - A **just-in-time** user, created the first time someone signs in through the identity
 *   provider. Its password hash has no known preimage and `sso_only` is set, which closes
 *   "Forgot your password?" to it until an administrator gives it a local password.
 * - The **break-glass** user, a real local admin with a real password, for the day the identity
 *   provider is down. It is created ready to sign in: enabled, not locked, no forced change.
 */
import { randomBytes } from "node:crypto";
import type {
  AuditEvent,
  AuditSink,
  CreateLocalUserInput,
  CreateUserInput,
  UserAdapter,
  VibeUser,
} from "@kisaesdevlab/vibe-auth";
import { and, eq, ne } from "drizzle-orm";
import { ROLES, type Role } from "@vibe-recap/shared";
import type { Db } from "../db/index.js";
import { users, type User } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { audit } from "../services/audit.js";

/** Most privileged first: the package breaks a tie between mapped groups by this order. */
export const PRODUCT_ROLES = ["admin", "preparer", "staff", "viewer"] as const satisfies readonly Role[];
export const ADMIN_ROLE: Role = "admin";

/**
 * Stated rather than left to the package's `defaultRoleMapFor`, which guesses from role names
 * and falls back to the least privileged role (it would make every `vibe-manager` a viewer).
 * A user in none of these groups is refused. `VIBE_OIDC_ROLE_MAP` or Settings > Authentication
 * overrides it.
 */
export const DEFAULT_ROLE_MAP: Record<string, Role> = {
  "vibe-admin": "admin",
  "vibe-it": "admin",
  "vibe-partner": "admin",
  "vibe-manager": "preparer",
  "vibe-staff": "staff",
};

/**
 * Recap signs people in by email and has no username column, so the break-glass account lives
 * under an address derived from Vibe Auth's username. A dotted domain, not `@localhost`: user
 * creation validates addresses and the rest of the suite settled on `<slug>.local`.
 */
export const BREAKGLASS_USERNAME = (process.env.VIBE_BREAKGLASS_USERNAME ?? "").trim() || "vibe-breakglass";
export const BREAKGLASS_EMAIL = `${BREAKGLASS_USERNAME.toLowerCase()}@vibe-recap.local`;

/** What someone may type into the sign-in form, resolved to the email the account lives under. */
export function resolveLoginEmail(identifier: string): string {
  const id = identifier.trim().toLowerCase();
  return id === BREAKGLASS_USERNAME.toLowerCase() ? BREAKGLASS_EMAIL : id;
}

/** The identifier Vibe Auth's local-login policy judges: the username for break-glass. */
export function policyIdentifier(email: string): string {
  return email === BREAKGLASS_EMAIL ? BREAKGLASS_USERNAME : email;
}

export function isBreakglass(user: Pick<User, "email">): boolean {
  return user.email === BREAKGLASS_EMAIL;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireProductRole(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`vibe-auth handed back a role Recap does not have: ${role}`);
  return role as Role;
}

function toVibeUser(row: User): VibeUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: !row.disabled,
    ...(isBreakglass(row) ? { local: true, username: BREAKGLASS_USERNAME } : {}),
  };
}

export function createVibeAuthUsers(db: Db): UserAdapter {
  const adapter: UserAdapter = {
    async findById(id) {
      // The package passes back whatever it stored; a non-uuid would make Postgres throw.
      if (!UUID.test(id)) return null;
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toVibeUser(row) : null;
    },

    async findByEmail(email) {
      // Every writer lowercases the address (setup, seed-admin, user create), as does the login.
      const [row] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
      return row ? toVibeUser(row) : null;
    },

    async findByUsername(username) {
      return adapter.findByEmail(resolveLoginEmail(username));
    },

    async create(input: CreateUserInput) {
      const email = input.email.trim().toLowerCase();
      const [row] = await db
        .insert(users)
        .values({
          email,
          name: input.name?.trim().slice(0, 120) || email,
          role: requireProductRole(input.role),
          // 48 random bytes, hashed and discarded. Nothing can sign in with it.
          passwordHash: await hashPassword(randomBytes(48).toString("base64url")),
          mustChangePassword: false,
          ssoOnly: true,
        })
        .returning();
      if (!row) throw new Error("user insert returned no row");
      return toVibeUser(row);
    },

    async setRole(userId, role) {
      const next = requireProductRole(role);

      // Roles re-sync from the identity provider on every sign-in, including the first one of an
      // existing local account linked by email. If that account is the firm's only working admin
      // and its groups map lower, syncing would leave nobody able to open Settings > Users or
      // Settings > Authentication to undo it, which is the lockout PATCH /api/users/:id already
      // refuses. Keep the role and say so. Break-glass is not "another admin": it is an emergency
      // account, not someone at a desk.
      if (next !== ADMIN_ROLE) {
        const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
        if (target?.role === ADMIN_ROLE) {
          const others = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.role, ADMIN_ROLE), eq(users.disabled, false), ne(users.id, userId), ne(users.email, BREAKGLASS_EMAIL)))
            .limit(1);
          if (others.length === 0) {
            await audit(db, {
              actor: { id: null, label: "vibe-auth" },
              action: "vibe.auth.role.changed",
              target: { type: "user", id: userId },
              meta: { refused: true, from: ADMIN_ROLE, to: next, why: "last_active_admin", note: "role kept; supersedes the adjacent role.changed row" },
            }).catch(() => undefined);
            return;
          }
        }
      }

      await db.update(users).set({ role: next, updatedAt: new Date() }).where(eq(users.id, userId));
    },

    async createLocalUser(input: CreateLocalUserInput) {
      const [row] = await db
        .insert(users)
        .values({
          // The CLI supplies an email from the adapter's `breakglassEmail`; derive it from the
          // username regardless so the two cannot drift apart.
          email: resolveLoginEmail(input.username),
          name: input.name.slice(0, 120),
          role: requireProductRole(input.role),
          passwordHash: await hashPassword(input.password),
          // It must be able to sign in during an outage: no forced change, no lock, enabled.
          mustChangePassword: false,
          disabled: false,
        })
        .returning();
      if (!row) throw new Error("user insert returned no row");
      return toVibeUser(row);
    },

    async setLocalPassword(userId, password) {
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(password), mustChangePassword: false, failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

    async setActive(userId, active) {
      await db.update(users).set({ disabled: !active, updatedAt: new Date() }).where(eq(users.id, userId));
    },
  };
  return adapter;
}

/**
 * Vibe Auth's events, written through Recap's own audit writer so they land in `audit_events`
 * beside every other access record. The event name is kept verbatim (`vibe.auth.*`).
 *
 * `actor_id` is a uuid column, so an id is only promoted to it when it has that shape; whatever
 * else the event carried stays in `meta`. Failures are swallowed by the package's contract
 * (auditing never breaks a sign-in) but logged, because a silent hole in an access log is its
 * own finding. Nothing from a return can reach these events: they describe firm users only.
 */
export function createVibeAuthAudit(db: Db, warn: (msg: string) => void = (m) => console.error(m)): AuditSink {
  return {
    async emit(event: AuditEvent) {
      const { type, at: _at, ip, user_id: userId, actor, ...meta } = event;
      const subject = typeof actor === "string" ? actor : typeof userId === "string" ? userId : null;
      const id = subject && UUID.test(subject) ? subject : null;
      try {
        let label = "vibe-auth";
        if (id) {
          const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
          if (row) label = row.email;
        }
        await audit(db, {
          actor: { id, label },
          action: type,
          target: typeof userId === "string" && UUID.test(userId) ? { type: "user", id: userId } : null,
          ip: typeof ip === "string" ? ip : null,
          meta,
        });
      } catch (err) {
        warn(`[vibe-auth] audit write failed for ${type}: ${(err as Error).message}`);
      }
    },
  };
}
