/**
 * Rotate the master key and re-wrap every per-file key:
 *   docker compose run --rm api rotate-master-key
 * Set MASTER_KEY_PASSPHRASE beforehand to switch to (or change) a passphrase-wrapped key:
 * the old passphrase is read from OLD_MASTER_KEY_PASSPHRASE when it differs.
 *
 * A single sign-on client secret saved from Settings > Authentication is wrapped to the same key
 * (Q57), so it is carried across too. If the database cannot be reached the rotation still goes
 * ahead, because it may be an emergency, and says that the secret must be entered again. ID tokens
 * kept on sessions are not carried: sign-out works without them.
 */
import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { Storage } from "../services/storage.js";

interface StoredAuth {
  clientSecretWrapped?: string;
  [k: string]: unknown;
}

async function main() {
  const config = loadConfig();
  const oldPass = process.env.OLD_MASTER_KEY_PASSPHRASE ?? config.MASTER_KEY_PASSPHRASE;
  const storage = new Storage(config.DATA_DIR, oldPass);
  await storage.init();

  const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
  let stored: StoredAuth | null = null;
  let clientSecret: string | null = null;
  try {
    const rows = await db.execute(sql`select value from auth_settings where key = 'vibe_auth'`);
    stored = (rows[0]?.value as StoredAuth | undefined) ?? null;
    if (stored?.clientSecretWrapped) clientSecret = await storage.unwrapSecret(stored.clientSecretWrapped);
  } catch (err) {
    console.warn(`could not read the single sign-on client secret (${(err as Error).message}); if one was saved under Settings > Authentication, enter it again after this rotation`);
  }

  const { rewrapped } = await storage.rotateMasterKey(config.MASTER_KEY_PASSPHRASE);
  console.log(`rotated master key; re-wrapped ${rewrapped} file keys`);

  if (stored && clientSecret !== null) {
    const next = { ...stored, clientSecretWrapped: await storage.wrapSecret(clientSecret) };
    await db.execute(sql`update auth_settings set value = ${JSON.stringify(next)}::jsonb, updated_at = now() where key = 'vibe_auth'`);
    console.log("re-wrapped the single sign-on client secret");
  }
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
