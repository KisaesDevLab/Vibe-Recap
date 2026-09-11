import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";

/** Firm-wide settings with their defaults. Keys are stable; the UI reads this shape. */
export const SETTING_DEFAULTS = {
  firm_name: "" as string,
  firm_logo: null as string | null, // data URL, png/svg, <= 200 KB
  color_primary: "#1f3a5f",
  color_secondary: "#e8b04b",
  signoff_sentence: "Please contact us with any questions.",
  voice: "af_heart",
  llm_provider: "router" as "router" | "ollama", // Q37: Vibe AI Router by default, bundled Ollama as the local option
  router_model: "" as string, // advisory; the router's policy decides what serves
  ollama_url: "" as string, // empty = use OLLAMA_URL env
  model_name: "" as string, // empty = use OLLAMA_MODEL env
  temperature: 0.3,
  ollama_timeout_s: 600,
  target_words: 350,
  concurrency: 1,
  ocr_enabled: true,
  greeting_use_first_names: true,
  retention_source_days: 30,
  retention_extraction_days: 365,
  retention_video_days: 90,
  retention_failed_days: 7,
  // Outgoing email (Q48): transactional mail to firm users only (invites, password resets), never to clients.
  email_provider: "none" as "none" | "emailit",
  emailit_api_key: "" as string, // empty = use EMAILIT_API_KEY env
  email_from: "" as string, // verified sender address on the Emailit domain
  email_from_name: "" as string, // display name; blank = firm name
  email_reply_to: "" as string,
  public_url: "" as string, // empty = PUBLIC_URL env, then ALLOWED_ORIGIN, then the request's origin
};

/** Settings that never leave the box in an export and are never imported. */
export const SECRET_SETTING_KEYS = ["emailit_api_key"] as const satisfies readonly SettingKey[];

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingsMap = { [K in SettingKey]: (typeof SETTING_DEFAULTS)[K] };

export async function getAllSettings(db: Db): Promise<SettingsMap> {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out as SettingsMap;
}

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<SettingsMap[K]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return (row ? row.value : SETTING_DEFAULTS[key]) as SettingsMap[K];
}

export async function setSetting<K extends SettingKey>(
  db: Db,
  key: K,
  value: SettingsMap[K],
  updatedBy: string | null,
): Promise<void> {
  // JSON null must land as the jsonb value 'null', not SQL NULL (the column is NOT NULL).
  const json = sql`${JSON.stringify(value ?? null)}::jsonb`;
  await db
    .insert(settings)
    .values({ key, value: json, updatedAt: new Date(), updatedBy })
    .onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: new Date(), updatedBy } });
}
