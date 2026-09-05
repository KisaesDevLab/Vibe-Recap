import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.js";
import { createDb, type Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { createRedis } from "../src/services/redis.js";
import { buildApp } from "../src/app.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://recap:recap@localhost:55432/recap_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:56379";

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  config: Config;
  close: () => Promise<void>;
}

export async function servicesAvailable(): Promise<boolean> {
  try {
    const { db, close } = createDb(TEST_DATABASE_URL, { max: 1 });
    await db.execute(sql`select 1`);
    await close();
    const redis = createRedis(TEST_REDIS_URL);
    await redis.ping();
    await redis.quit();
    return true;
  } catch {
    console.warn(`\n[integration] Postgres/Redis not reachable at ${TEST_DATABASE_URL} / ${TEST_REDIS_URL}. Run "npm run test:services". Skipping.\n`);
    return false;
  }
}

export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
}

export async function createTestContext(overrides: Partial<Config> = {}): Promise<TestContext> {
  const config: Config = {
    ...loadConfig({}),
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    COOKIE_SECURE: false,
    TRUST_PROXY: true,
    LOG_LEVEL: "silent",
    DATA_DIR: process.env.TEST_DATA_DIR ?? "./.test-data",
    ...overrides,
  };
  const { db, close } = createDb(config.DATABASE_URL, { max: 4 });
  await resetDatabase(db);
  const redis = createRedis(config.REDIS_URL);
  await redis.flushdb();
  const app = await buildApp({ config, db, redis });
  await app.ready();
  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await redis.quit();
      await close();
    },
  };
}

/** Minimal cookie jar for inject()-based tests. */
export class Client {
  cookies = new Map<string, string>();
  csrf: string | null = null;
  constructor(private app: FastifyInstance) {}

  private cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url,
      payload: body as Record<string, unknown> | undefined,
      headers: {
        cookie: this.cookieHeader(),
        ...(this.csrf ? { "x-csrf-token": this.csrf } : {}),
        ...headers,
      },
    });
    const setCookie = res.headers["set-cookie"];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = c.split(";");
      const [k, v] = pair!.split("=");
      if (v === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(k!);
      else this.cookies.set(k!, v!);
    }
    return res;
  }

  get = (url: string) => this.request("GET", url);
  post = (url: string, body?: unknown, headers?: Record<string, string>) => this.request("POST", url, body, headers);

  async setup(email = "admin@example.com", password = "correct-horse-battery-staple") {
    const res = await this.post("/api/setup", { email, name: "Admin", password });
    if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
    const me = await this.get("/api/auth/me");
    this.csrf = me.json().csrfToken;
    return me.json();
  }

  async login(email: string, password: string) {
    const res = await this.post("/api/auth/login", { email, password });
    if (res.statusCode === 200) this.csrf = res.json().csrfToken;
    return res;
  }
}
