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
  LICENSE_SERVER_URL: z.string().default("https://licensing.kisaes.com"),
  MASTER_KEY_PASSPHRASE: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  COOKIE_SECURE: bool.default(true),
  TRUST_PROXY: bool.default(false),
  SESSION_IDLE_HOURS: z.coerce.number().default(12),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().default(7),
  LOGIN_MAX_FAILURES: z.coerce.number().int().default(10),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().default(15),
  RECAP_VERSION: z.string().default("0.1.0"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
