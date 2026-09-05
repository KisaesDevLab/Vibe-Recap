/**
 * Run database migrations explicitly and exit:
 *   docker compose run --rm api migrate
 * The Vibe Appliance calls this at enable and update time with MIGRATIONS_AUTO=false on the
 * server container; standalone installs migrate at boot instead. Idempotent.
 */
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";

async function main() {
  const config = loadConfig();
  const { db, close } = createDb(config.DATABASE_URL, { max: 2 });
  await runMigrations(db);
  await close();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
