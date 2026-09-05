import type { FastifyInstance } from "fastify";
import type { HealthResponse, ReadyResponse } from "@vibe-recap/shared";
import { sql } from "drizzle-orm";
import { redisHealthy } from "../services/redis.js";
import { ollamaStatus } from "../services/ollama.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/healthz", { config: { auth: false } }, async (): Promise<HealthResponse> => {
    return { ok: true, version: app.config.RECAP_VERSION };
  });

  app.get("/readyz", { config: { auth: false } }, async (_req, reply): Promise<ReadyResponse> => {
    const [postgres, redis, ollama] = await Promise.all([
      app.db
        .execute(sql`select 1`)
        .then(() => true)
        .catch(() => false),
      redisHealthy(app.redis),
      ollamaStatus(app.config.OLLAMA_URL).then((s) => s.reachable),
    ]);
    const status: ReadyResponse["status"] = !postgres || !redis ? "failed" : !ollama ? "degraded" : "ok";
    reply.code(status === "failed" ? 503 : 200);
    return { status, checks: { postgres, redis, ollama } };
  });
}
