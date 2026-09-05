/**
 * Create the first admin from the CLI:
 *   docker compose run --rm api seed-admin admin@firm.com "Jane Preparer" 'a-long-password'
 * or with env ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD.
 * Refuses to run when any user already exists.
 */
import { count } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { users } from "../db/schema.js";
import { checkPasswordPolicy, hashPassword } from "../auth/password.js";
import { audit } from "../services/audit.js";

async function main() {
  // Positional args, then ADMIN_*, then the Vibe Appliance's SEED_ADMIN_* conventions.
  const [email, name, password] = [
    process.argv[2] ?? process.env.ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL,
    process.argv[3] ?? process.env.ADMIN_NAME ?? process.env.SEED_ADMIN_NAME ?? "Administrator",
    process.argv[4] ?? process.env.ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD,
  ];
  if (!email || !password) {
    console.error("usage: seed-admin <email> <name> <password>   (or ADMIN_EMAIL / ADMIN_NAME / ADMIN_PASSWORD env)");
    process.exit(2);
  }
  const reason = checkPasswordPolicy(password);
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
  const config = loadConfig();
  const { db, close } = createDb(config.DATABASE_URL, { max: 2 });
  await runMigrations(db);
  const [row] = await db.select({ n: count() }).from(users);
  if ((row?.n ?? 0) > 0) {
    // Idempotent for orchestrators that re-run the seed on every enable.
    console.log("users already exist; nothing to seed (use /settings/users to add more)");
    await close();
    process.exit(0);
  }
  const [u] = await db
    .insert(users)
    .values({ email: email.toLowerCase(), name, role: "admin", passwordHash: await hashPassword(password) })
    .returning();
  await audit(db, { actor: { id: u!.id, label: u!.email }, action: "setup.complete", target: { type: "user", id: u!.id }, meta: { via: "cli" } });
  console.log(`created admin ${u!.id}`);
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
