import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { loggerOptions } from "./logger.js";
import { HttpError } from "./errors.js";
import { authPluginRegistered } from "./plugins/auth.js";
import type { SessionPolicy } from "./auth/session.js";
import { commonPasswordListSize } from "./auth/password.js";
import { healthRoutes } from "./routes/health.js";
import { setupRoutes } from "./routes/setup.js";
import { authRoutes } from "./routes/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    redis: Redis;
    sessionPolicy: SessionPolicy;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(deps.config.LOG_LEVEL),
    trustProxy: deps.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  app.decorate("config", deps.config);
  app.decorate("db", deps.db);
  app.decorate("redis", deps.redis);
  app.decorate("sessionPolicy", {
    idleHours: deps.config.SESSION_IDLE_HOURS,
    absoluteDays: deps.config.SESSION_ABSOLUTE_DAYS,
  });

  if (commonPasswordListSize() === 0) {
    app.log.error("common password list missing or empty; breach check is disabled");
  }

  await app.register(cookie);
  await app.register(rateLimit, { global: false, redis: deps.redis, nameSpace: "recap-rl:" });
  await app.register(authPluginRegistered, { policy: app.sessionPolicy });

  app.setErrorHandler((raw: unknown, req, reply) => {
    const err = raw as Error & { statusCode?: number; code?: string };
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send({ error: "validation", message: "Invalid request", details: err.issues });
      return;
    }
    const status = err.statusCode;
    if (status && status < 500) {
      reply.code(status).send({ error: err.code ?? "error", message: err.message });
      return;
    }
    req.log.error({ err }, "unhandled error");
    reply.code(500).send({ error: "internal", message: "Internal server error" });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not_found", message: `Route ${req.method} ${req.url} not found` });
  });

  await app.register(healthRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);

  return app;
}
