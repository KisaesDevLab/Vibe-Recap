import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { createRedis } from "./services/redis.js";
import { buildApp } from "./app.js";
import { createLogger } from "./logger.js";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const { db, close } = createDb(config.DATABASE_URL);
  log.info("running migrations");
  await runMigrations(db);
  const redis = createRedis(config.REDIS_URL);
  const app = await buildApp({ config, db, redis });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await redis.quit();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
