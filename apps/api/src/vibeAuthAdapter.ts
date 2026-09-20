/**
 * Adapter for the Vibe Auth break-glass CLI (Q57):
 *   docker exec -i <api container> breakglass ensure|rotate|status --json
 *
 * The CLI finds this file through `"vibeAuth": { "adapter": … }` in apps/api/package.json, read
 * from the working directory the entrypoint sets (/app/apps/api). It is how the Vibe Appliance
 * provisions the emergency account, so it imports the user adapter and nothing from the HTTP
 * server. The password is printed once, by `ensure` when it creates the account and by `rotate`.
 */
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { ADMIN_ROLE, BREAKGLASS_EMAIL, createVibeAuthAudit, createVibeAuthUsers } from "./lib/vibeAuthUsers.js";

export default function adapter() {
  const { db, close } = createDb(loadConfig().DATABASE_URL, { max: 2 });
  return {
    users: createVibeAuthUsers(db),
    audit: createVibeAuthAudit(db),
    adminRole: ADMIN_ROLE,
    breakglassEmail: BREAKGLASS_EMAIL,
    close,
  };
}
