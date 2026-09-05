import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { checkLicense, currentState, setLicenseKey } from "../services/license.js";

export async function licenseRoutes(app: FastifyInstance) {
  app.get("/api/settings/license", { preHandler: requireRole("admin") }, async () => {
    const state = await currentState(app);
    return { ...state, key: undefined };
  });

  app.put("/api/settings/license", { preHandler: requireRole("admin") }, async (req) => {
    const body = z.object({ key: z.string().min(8).max(200) }).parse(req.body);
    await setLicenseKey(app, body.key, req.auth!.user.id);
    await audit(app.db, { actor: actorOf(req), action: "license.key_set", ip: req.ip });
    const state = await checkLicense(app, app.licenseClient);
    return { ...state, key: undefined };
  });

  app.post("/api/settings/license/check", { preHandler: requireRole("admin") }, async (req) => {
    const state = await checkLicense(app, app.licenseClient);
    await audit(app.db, { actor: actorOf(req), action: "license.manual_check", ip: req.ip, meta: { status: state.status } });
    return { ...state, key: undefined };
  });
}
