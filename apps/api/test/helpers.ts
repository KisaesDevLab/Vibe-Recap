import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.js";
import { createDb, type Db } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { createRedis } from "../src/services/redis.js";
import { buildApp } from "../src/app.js";
import { Storage } from "../src/services/storage.js";
import type { StageResult, Stager } from "../src/services/queue.js";
import { EmailError, type EmailClient, type OutboundEmail } from "../src/services/email.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Stands in for the Python worker: answers from a table keyed by sha256, or a default. */
export class FakeStager implements Stager {
  bySha = new Map<string, StageResult>();
  fallback: StageResult = { ok: true, firstName: "Test", lastName: "Person", taxYear: 2025, software: "ultratax", form: "1040", pageCount: 2 };
  constructor(private storage: Storage) {}
  async stage(stageId: string, fileId: string): Promise<StageResult> {
    const rel = `blobs/staging/${stageId}/${fileId}.age`;
    const data = await this.storage.get(rel, rel.slice(0, -4) + ".key");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(data).digest("hex");
    return this.bySha.get(sha) ?? this.fallback;
  }
}

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://recap:recap@localhost:55432/recap_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:56379";

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  config: Config;
  storage: Storage;
  stager: FakeStager;
  email: FakeEmailClient;
  dataDir: string;
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

/** Records every outgoing message instead of calling Emailit. `fail` makes the next sends throw. */
export class FakeEmailClient implements EmailClient {
  sent: OutboundEmail[] = [];
  fail: string | null = null;
  async send(msg: OutboundEmail) {
    if (this.fail) throw new EmailError(this.fail, 401);
    this.sent.push(msg);
    return { id: `em_test_${this.sent.length}` };
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
  /** First absolute http(s) link found in the plain-text body of the last message. */
  lastLink(): string {
    const m = /https?:\/\/\S+/.exec(this.last()?.text ?? "");
    if (!m) throw new Error("no link in last email");
    return m[0];
  }
}

export async function createTestContext(overrides: Partial<Config> = {}, deps: { emailClient?: EmailClient } = {}): Promise<TestContext> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "recap-data-"));
  const config: Config = {
    ...loadConfig({}),
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    COOKIE_SECURE: false,
    TRUST_PROXY: true,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATA_DIR: dataDir,
    ...overrides,
  };
  const { db, close } = createDb(config.DATABASE_URL, { max: 4 });
  await resetDatabase(db);
  const redis = createRedis(config.REDIS_URL);
  await redis.flushdb();
  const storage = new Storage(dataDir);
  await storage.init();
  const stager = new FakeStager(storage);
  const email = (deps.emailClient as FakeEmailClient | undefined) ?? new FakeEmailClient();
  const app = await buildApp({ config, db, redis, storage, stager, emailClient: email });
  await app.ready();
  return {
    app,
    db,
    config,
    storage,
    stager,
    email,
    dataDir,
    close: async () => {
      await app.close();
      await redis.quit();
      await close();
      await fs.rm(dataDir, { recursive: true, force: true });
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
