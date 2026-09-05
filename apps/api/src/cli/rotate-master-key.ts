/**
 * Rotate the master key and re-wrap every per-file key:
 *   docker compose run --rm api rotate-master-key
 * Set MASTER_KEY_PASSPHRASE beforehand to switch to (or change) a passphrase-wrapped key:
 * the old passphrase is read from OLD_MASTER_KEY_PASSPHRASE when it differs.
 */
import { loadConfig } from "../config.js";
import { Storage } from "../services/storage.js";

async function main() {
  const config = loadConfig();
  const oldPass = process.env.OLD_MASTER_KEY_PASSPHRASE ?? config.MASTER_KEY_PASSPHRASE;
  const storage = new Storage(config.DATA_DIR, oldPass);
  await storage.init();
  const { rewrapped } = await storage.rotateMasterKey(config.MASTER_KEY_PASSPHRASE);
  console.log(`rotated master key; re-wrapped ${rewrapped} file keys`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
