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
import multipart from "@fastify/multipart";
import { clientRoutes } from "./routes/clients.js";
import { jobRoutes } from "./routes/jobs.js";
import { uploadRoutes } from "./routes/uploads.js";
import { extractionRoutes } from "./routes/extraction.js";
import { scriptRoutes } from "./routes/script.js";
import { reviewRoutes } from "./routes/review.js";
import { releaseRoutes } from "./routes/release.js";
import { retentionRoutes } from "./routes/retention.js";
import type { Storage } from "./services/storage.js";
import { Queues, type Stager } from "./services/queue.js";
import { StagingService } from "./services/staging.js";
import { startCron } from "./services/cron.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    redis: Redis;
    sessionPolicy: SessionPolicy;
    storage: Storage;
    queues: Queues;
    staging: StagingService;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  storage: Storage;
  /** Override the staging identifier (tests use a fake instead of the worker). */
  stager?: Stager;
  /** Start node-cron jobs (off in tests). */
  cron?: boolean;
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

  app.decorate("storage", deps.storage);
  const queues = new Queues(deps.redis);
  app.decorate("queues", queues);
  app.decorate(
    "staging",
    new StagingService(deps.redis, deps.db, deps.storage, deps.stager ?? queues, (jobId) => queues.enqueueRecap(jobId)),
  );

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 200, fields: 10 } });
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
  await app.register(clientRoutes);
  await app.register(jobRoutes);
  await app.register(uploadRoutes);
  await app.register(extractionRoutes);
  await app.register(scriptRoutes);
  await app.register(reviewRoutes);
  await app.register(releaseRoutes);
  await app.register(retentionRoutes);

  const tasks = deps.cron ? startCron(app) : [];
  app.addHook("onClose", async () => {
    for (const t of tasks) await t.stop();
    await queues.close();
  });

  return app;
}
