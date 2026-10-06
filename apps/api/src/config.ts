import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : !["0", "false", "no", ""].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().default("postgres://recap:recap@localhost:55432/recap_test"),
  REDIS_URL: z.string().default("redis://localhost:56379"),
  DATA_DIR: z.string().default("./data"),
  OLLAMA_URL: z.string().default("http://ollama:11434"),
  OLLAMA_MODEL: z.string().default("qwen3:8b"),
  OLLAMA_OCR_MODEL: z.string().default("glm-ocr"),
  /** Vibe AI Router (default script-generation provider). Empty token = bundled Ollama. */
  VIBE_AI_ROUTER_URL: z.string().default("http://vibe-ai-router:8220"),
  VIBE_AI_TOKEN: z.string().default(""),
  MASTER_KEY_PASSPHRASE: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  COOKIE_SECURE: bool.default(true),
  TRUST_PROXY: bool.default(false),
  SESSION_IDLE_HOURS: z.coerce.number().default(12),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().default(7),
  LOGIN_MAX_FAILURES: z.coerce.number().int().default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().default(15),
  RECAP_VERSION: z.string().default("0.6.2"),
  /** Run migrations at boot (default). The Vibe Appliance sets false and runs `migrate` explicitly. */
  MIGRATIONS_AUTO: bool.default(true),
  /** Comma-separated list of allowed Origin values for state-changing requests; empty = same-origin only. */
  ALLOWED_ORIGIN: z.string().default(""),
  /** Outgoing email (Q48): Emailit API key. Settings > Email can override it; empty here and there = no email. */
  EMAILIT_API_KEY: z.string().default(""),
  EMAILIT_API_URL: z.string().default("https://api.emailit.com"),
  /** Public URL of this install for links in emails, e.g. https://recap.yourfirm.com. Falls back to ALLOWED_ORIGIN, then the request. */
  PUBLIC_URL: z.string().default(""),
  /**
   * Client sharing (Q73): the public address of the watch host, e.g. https://watch.yourfirm.com,
   * served by the Cloudflare tunnel. Settings > Sharing can hold it instead. Empty in both = no sharing.
   */
  SHARE_PUBLIC_URL: z.string().default(""),
  /** The watch-only listener the public watch host is proxied to (watchListener.ts). 0 = off. */
  WATCH_PORT: z.coerce.number().int().min(0).default(3001),
  /** Twilio for share links and codes by text message (Q73). Settings > Sharing can hold the same values. */
  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_FROM: z.string().default(""),
  /** The Vibe Appliance's Email & SMS settings (appliance.env): used when Settings > Sharing leaves the provider and sender to the environment. */
  SMS_PROVIDER: z.string().default(""),
  FROM_NUMBER: z.string().default(""),
  TWILIO_API_URL: z.string().default("https://api.twilio.com"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
