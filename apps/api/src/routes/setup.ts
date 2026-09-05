import type { FastifyInstance } from "fastify";
import { count, sql } from "drizzle-orm";
import { z } from "zod";
import type { SetupStatus } from "@vibe-recap/shared";
import { users } from "../db/schema.js";
import { checkPasswordPolicy, hashPassword } from "../auth/password.js";
import { badRequest, conflict } from "../errors.js";
import { audit } from "../services/audit.js";
import { SESSION_COOKIE, createSession } from "../auth/session.js";
import { cookieOptions } from "./auth.js";

const setupBody = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  password: z.string().max(512),
});

export async function userCount(app: FastifyInstance): Promise<number> {
  const [row] = await app.db.select({ n: count() }).from(users);
  return row?.n ?? 0;
}

/** First-run admin creation. Only answers while the users table is empty. */
export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", { config: { auth: false } }, async (): Promise<SetupStatus> => {
    return { needed: (await userCount(app)) === 0 };
  });

  app.post(
    "/api/setup",
    { config: { auth: false, csrf: false, rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = setupBody.parse(req.body);
      const reason = checkPasswordPolicy(body.password);
      if (reason) throw badRequest(reason);
      const passwordHash = await hashPassword(body.password);

      const created = await app.db.transaction(async (tx) => {
        // Serialize concurrent setup attempts; only the first wins.
        await tx.execute(sql`select pg_advisory_xact_lock(4242)`);
        const [row] = await tx.select({ n: count() }).from(users);
        if ((row?.n ?? 0) > 0) return null;
        const [u] = await tx
          .insert(users)
          .values({ email: body.email.toLowerCase(), name: body.name, role: "admin", passwordHash })
          .returning();
        return u!;
      });
      if (!created) throw conflict("Setup already completed");

      await audit(app.db, {
        actor: { id: created.id, label: created.email },
        action: "setup.complete",
        target: { type: "user", id: created.id },
        ip: req.ip,
      });
      const session = await createSession(app.db, created.id, app.sessionPolicy, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await audit(app.db, {
        actor: { id: created.id, label: created.email },
        action: "auth.login",
        target: { type: "user", id: created.id },
        ip: req.ip,
        meta: { via: "setup" },
      });
      reply.setCookie(SESSION_COOKIE, session.id, cookieOptions(app));
      reply.code(201);
      return { ok: true };
    },
  );
}
