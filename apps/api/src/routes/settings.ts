import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { ollamaStatus } from "../services/ollama.js";
import { registerTaskClasses } from "../services/airouter.js";
import { getAllSettings, SECRET_SETTING_KEYS, SETTING_DEFAULTS, setSetting, type SettingKey } from "../services/settings.js";
import { badRequest } from "../errors.js";
import { emailConfig, isEmailAddress, publicUrl, sendEmail } from "../services/email.js";
import { testEmail } from "../services/email-templates.js";

const GENERAL_KEYS = [
  "firm_name",
  "firm_logo",
  "color_primary",
  "color_secondary",
  "signoff_sentence",
  "voice",
  "llm_provider",
  "router_model",
  "model_name",
  "ollama_url",
  "temperature",
  "ollama_timeout_s",
  "target_words",
  "concurrency",
  "ocr_enabled",
  "greeting_use_first_names",
] as const satisfies readonly SettingKey[];

const generalBody = z.object({
  firm_name: z.string().max(120).optional(),
  firm_logo: z.string().max(280_000).nullable().optional(), // data: URL, <= ~200 KB
  color_primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  color_secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  signoff_sentence: z.string().max(300).optional(),
  voice: z.enum(["af_heart", "af_bella", "am_michael", "am_adam"]).optional(),
  llm_provider: z.enum(["router", "ollama"]).optional(),
  router_model: z.string().max(120).optional(),
  model_name: z.string().max(100).optional(),
  ollama_url: z.string().max(200).optional(),
  temperature: z.number().min(0).max(1.5).optional(),
  ollama_timeout_s: z.number().int().min(60).max(3600).optional(),
  target_words: z.number().int().min(250).max(450).optional(),
  concurrency: z.number().int().min(1).max(4).optional(),
  ocr_enabled: z.boolean().optional(),
  greeting_use_first_names: z.boolean().optional(),
});

export const VOICES = { af_heart: "Heart (female)", af_bella: "Bella (female)", am_michael: "Michael (male)", am_adam: "Adam (male)" };

function profilesDir(app: FastifyInstance): string {
  return path.join(app.config.DATA_DIR, "form-profiles");
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings/general", { preHandler: requireRole("admin") }, async () => {
    const s = await getAllSettings(app.db);
    return {
      settings: Object.fromEntries(GENERAL_KEYS.map((k) => [k, s[k]])),
      defaults: { ollama_url: app.config.OLLAMA_URL, model_name: app.config.OLLAMA_MODEL, ocr_model: app.config.OLLAMA_OCR_MODEL },
      voices: VOICES,
      note: "Concurrency takes effect when the worker container restarts (docker compose restart worker).",
    };
  });

  app.put("/api/settings/general", { preHandler: requireRole("admin") }, async (req) => {
    const body = generalBody.parse(req.body);
    if (body.firm_logo && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(body.firm_logo)) throw badRequest("Logo must be a PNG, JPEG, SVG, or WebP data URL");
    const user = req.auth!.user;
    const changed: string[] = [];
    for (const k of GENERAL_KEYS) {
      const v = body[k as keyof typeof body];
      if (v === undefined) continue;
      await setSetting(app.db, k, v as never, user.id);
      changed.push(k);
    }
    await audit(app.db, { actor: actorOf(req), action: "settings.update", target: { type: "settings", id: "general" }, ip: req.ip, meta: { keys: changed } });
    const s = await getAllSettings(app.db);
    return { settings: Object.fromEntries(GENERAL_KEYS.map((k) => [k, s[k]])) };
  });

  /** "Test Ollama": reachability and model presence, using the saved URL/model or the env defaults. */
  app.post("/api/settings/test-ollama", { preHandler: requireRole("admin") }, async (req) => {
    const body = z.object({ ollama_url: z.string().max(200).optional(), model_name: z.string().max(100).optional() }).parse(req.body ?? {});
    const s = await getAllSettings(app.db);
    const url = body.ollama_url || s.ollama_url || app.config.OLLAMA_URL;
    const model = body.model_name || s.model_name || app.config.OLLAMA_MODEL;
    const status = await ollamaStatus(url, 5000);
    const hasModel = status.models.some((m) => m === model || m.split(":")[0] === model.split(":")[0]);
    const hasOcr = status.models.some((m) => m.split(":")[0] === app.config.OLLAMA_OCR_MODEL.split(":")[0]);
    const router = await registerTaskClasses(app);
    return {
      provider: s.llm_provider,
      url,
      model,
      reachable: status.reachable,
      models: status.models,
      hasModel,
      ocrModel: app.config.OLLAMA_OCR_MODEL,
      hasOcrModel: hasOcr,
      router: { configured: router.configured, url: router.url, reachable: router.reachable, registered: router.registered, error: router.error },
    };
  });

  // ---- Outgoing email (Q48) ----------------------------------------------------------------

  const emailKeys = ["email_provider", "email_from", "email_from_name", "email_reply_to", "public_url"] as const satisfies readonly SettingKey[];
  const emailBody = z.object({
    email_provider: z.enum(["none", "emailit"]).optional(),
    /** Omit to keep the stored key; empty string clears it. */
    emailit_api_key: z.string().max(300).optional(),
    email_from: z.string().max(200).optional(),
    email_from_name: z.string().max(120).optional(),
    email_reply_to: z.string().max(200).optional(),
    public_url: z.string().max(200).optional(),
  });

  async function emailView() {
    const s = await getAllSettings(app.db);
    const cfg = await emailConfig(app);
    return {
      settings: Object.fromEntries(emailKeys.map((k) => [k, s[k]])),
      apiKeySet: cfg.apiKeySet,
      apiKeySource: cfg.apiKeySource,
      apiKeyMasked: s.emailit_api_key ? `${s.emailit_api_key.slice(0, 6)}…${s.emailit_api_key.slice(-4)}` : null,
      enabled: cfg.enabled,
      reason: cfg.reason,
      effectiveFromName: cfg.fromName,
      effectivePublicUrl: await publicUrl(app),
    };
  }

  app.get("/api/settings/email", { preHandler: requireRole("admin") }, async () => emailView());

  app.put("/api/settings/email", { preHandler: requireRole("admin") }, async (req) => {
    const body = emailBody.parse(req.body);
    for (const k of ["email_from", "email_reply_to"] as const) {
      const v = body[k]?.trim();
      if (v && !isEmailAddress(v)) throw badRequest(`${k === "email_from" ? "Sender" : "Reply-to"} must be a plain email address`);
    }
    if (body.public_url?.trim() && !/^https?:\/\/[^/\s]+$/i.test(body.public_url.trim().replace(/\/+$/, ""))) throw badRequest("Public URL must look like https://recap.yourfirm.com (no path)");
    const user = req.auth!.user;
    const changed: string[] = [];
    for (const k of emailKeys) {
      const v = body[k];
      if (v === undefined) continue;
      const clean = k === "public_url" ? v.trim().replace(/\/+$/, "") : v.trim();
      await setSetting(app.db, k, clean as never, user.id);
      changed.push(k);
    }
    if (body.emailit_api_key !== undefined) {
      await setSetting(app.db, "emailit_api_key", body.emailit_api_key.trim(), user.id);
      changed.push(body.emailit_api_key.trim() ? "emailit_api_key" : "emailit_api_key:cleared");
    }
    await audit(app.db, { actor: actorOf(req), action: "settings.update", target: { type: "settings", id: "email" }, ip: req.ip, meta: { keys: changed } });
    return emailView();
  });

  /** Send a test message to the signed-in admin (or a given address) with the saved configuration. */
  app.post("/api/settings/email/test", { preHandler: requireRole("admin") }, async (req) => {
    const body = z.object({ to: z.string().max(200).optional() }).parse(req.body ?? {});
    const user = req.auth!.user;
    const to = (body.to?.trim() || user.email).toLowerCase();
    if (!isEmailAddress(to)) throw badRequest("Recipient must be an email address");
    const cfg = await emailConfig(app);
    if (!cfg.enabled) throw badRequest(cfg.reason ? `Outgoing email is not available: ${cfg.reason.toLowerCase()}` : "Outgoing email is not configured");
    try {
      const r = await sendEmail(app, to, "test", testEmail({ firmName: (await getAllSettings(app.db)).firm_name, url: await publicUrl(app, req), sentBy: user.name }));
      await audit(app.db, { actor: actorOf(req), action: "settings.email_test", ip: req.ip, meta: { ok: true } });
      return { ok: true, id: r.id };
    } catch (err) {
      await audit(app.db, { actor: actorOf(req), action: "settings.email_test", ip: req.ip, meta: { ok: false, error: (err as Error).message.slice(0, 200) } });
      throw badRequest((err as Error).message);
    }
  });

  /** Export firm settings and form profiles as one JSON document (no client data, no keys). */
  app.get("/api/settings/backup/export", { preHandler: requireRole("admin") }, async (req, reply) => {
    const s = await getAllSettings(app.db);
    const settings: Partial<typeof s> = { ...s };
    for (const k of SECRET_SETTING_KEYS) delete settings[k];
    const profiles: Record<string, string> = {};
    try {
      for (const name of await fs.readdir(profilesDir(app))) {
        if (name.endsWith(".yaml")) profiles[name] = await fs.readFile(path.join(profilesDir(app), name), "utf8");
      }
    } catch {
      /* profiles not seeded yet */
    }
    await audit(app.db, { actor: actorOf(req), action: "settings.export", ip: req.ip, meta: { profiles: Object.keys(profiles).length } });
    reply.header("content-type", "application/json");
    reply.header("content-disposition", `attachment; filename="vibe-recap-settings-${new Date().toISOString().slice(0, 10)}.json"`);
    return { version: 1, exportedAt: new Date().toISOString(), settings, profiles };
  });

  app.post("/api/settings/backup/import", { preHandler: requireRole("admin") }, async (req) => {
    const body = z
      .object({
        mode: z.enum(["merge", "replace"]).default("merge"),
        settings: z.record(z.string(), z.unknown()).optional(),
        profiles: z.record(z.string(), z.string()).optional(),
      })
      .parse(req.body);
    const user = req.auth!.user;
    const applied: string[] = [];
    const keys = body.mode === "replace" ? (Object.keys(SETTING_DEFAULTS) as SettingKey[]) : (Object.keys(body.settings ?? {}) as SettingKey[]);
    for (const k of keys) {
      if (!(k in SETTING_DEFAULTS) || (SECRET_SETTING_KEYS as readonly string[]).includes(k)) continue;
      const v = body.settings && k in body.settings ? body.settings[k] : SETTING_DEFAULTS[k];
      await setSetting(app.db, k, v as never, user.id);
      applied.push(k);
    }
    let profilesWritten = 0;
    if (body.profiles) {
      await fs.mkdir(profilesDir(app), { recursive: true });
      if (body.mode === "replace") {
        for (const name of await fs.readdir(profilesDir(app))) if (name.endsWith(".yaml")) await fs.rm(path.join(profilesDir(app), name));
      }
      for (const [name, content] of Object.entries(body.profiles)) {
        if (!/^[A-Za-z0-9_.-]+\.yaml$/.test(name)) throw badRequest(`Bad profile name ${name}`);
        await fs.writeFile(path.join(profilesDir(app), name), content, "utf8");
        profilesWritten++;
      }
    }
    await audit(app.db, { actor: actorOf(req), action: "settings.import", ip: req.ip, meta: { mode: body.mode, keys: applied, profiles: profilesWritten } });
    return { ok: true, settings: applied.length, profiles: profilesWritten };
  });
}
