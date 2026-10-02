import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, createTestContext, servicesAvailable, type TestContext } from "./helpers.js";
import { clients, files, jobs, users } from "../src/db/schema.js";
import { hashPassword } from "../src/auth/password.js";

const available = await servicesAvailable();

/** Shape the worker writes (worker/recap/script/generate.py _store_capture). */
const RUN = {
  run: "generate",
  provider: "router",
  at: "2026-10-01T12:00:00+00:00",
  attempts: [
    {
      attempt: 1,
      at: "2026-10-01T12:00:01+00:00",
      model: "anthropic/claude-sonnet-5-5",
      finish_reason: "length",
      prompt_tokens: 1500,
      completion_tokens: 1200,
      ms: 9000,
      ok: false,
      words: 106,
      errors: ["output cut off at the token limit", "too short: 106 words, need at least 250"],
      request: [
        { role: "system", content: "You write short, warm narration scripts." },
        { role: "user", content: "Write the narration script for this return." },
      ],
      response: "[[slide:greeting]] Hello Alex.",
    },
  ],
};

describe.skipIf(!available)("AI exchanges viewer", () => {
  let ctx: TestContext;
  let admin: Client;
  let jobId: string;
  let fileId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = new Client(ctx.app);
    const me = await admin.setup();
    const [client] = await ctx.db.insert(clients).values({ name: "Fixture, Alex", normalizedName: "fixture, alex" }).returning();
    const [job] = await ctx.db
      .insert(jobs)
      .values({ status: "failed", step: "script", errorStep: "script", errorMessage: "validator rejected the script", clientId: client!.id, uploadedBy: me.user.id, sourceSha256: "a".repeat(64), taxYear: 2025, software: "ultratax" })
      .returning();
    jobId = job!.id;
    const blob = await ctx.storage.put(jobId, Buffer.from(JSON.stringify(RUN)));
    fileId = blob.id;
    await ctx.db.insert(files).values({ id: blob.id, jobId, kind: "ai_exchange", path: blob.path, keyPath: blob.keyPath, sha256: blob.sha256, size: blob.size, seq: 1 });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("lists runs as metadata only, without the prompt or reply, and does not audit the list", async () => {
    const res = await admin.get(`/api/jobs/${jobId}/ai-exchanges`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false); // the setting defaults off
    expect(body.runs).toHaveLength(1);
    const a = body.runs[0].attempts[0];
    expect(a).toMatchObject({ attempt: 1, model: "anthropic/claude-sonnet-5-5", finishReason: "length", promptTokens: 1500, completionTokens: 1200, ok: false, words: 106 });
    expect(a.request).toBeUndefined();
    expect(a.response).toBeUndefined();
    expect(res.body).not.toContain("narration scripts");
    const reads = await ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'file.read' and target_id = ${jobId}`);
    expect(Number(reads[0]!.n)).toBe(0);
  });

  it("returns one run in full and audits the read", async () => {
    const res = await admin.get(`/api/jobs/${jobId}/ai-exchanges/${fileId}`);
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json().attempts[0];
    expect(a.request).toEqual(RUN.attempts[0]!.request);
    expect(a.response).toBe(RUN.attempts[0]!.response);
    const reads = await ctx.db.execute<{ meta: { kind: string } }>(sql`select meta from audit_events where action = 'file.read' and target_id = ${jobId}`);
    expect(reads.map((r) => r.meta.kind)).toEqual(["ai_exchange"]);
  });

  it("404s an unknown or malformed run id", async () => {
    expect((await admin.get(`/api/jobs/${jobId}/ai-exchanges/00000000-0000-0000-0000-000000000000`)).statusCode).toBe(404);
    expect((await admin.get(`/api/jobs/${jobId}/ai-exchanges/not-a-uuid`)).statusCode).toBe(404);
  });

  it("refuses staff: the prompt carries names and figures, preparer and up only", async () => {
    await ctx.db.insert(users).values({ email: "staff@example.com", name: "S", role: "staff", passwordHash: await hashPassword("staff-password-long") });
    const staff = new Client(ctx.app);
    await staff.login("staff@example.com", "staff-password-long");
    expect((await staff.get(`/api/jobs/${jobId}/ai-exchanges`)).statusCode).toBe(403);
    expect((await staff.get(`/api/jobs/${jobId}/ai-exchanges/${fileId}`)).statusCode).toBe(403);
  });

  it("saves the capture setting through General settings", async () => {
    const put = await admin.request("PUT", "/api/settings/general", { capture_ai_exchanges: true });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().settings.capture_ai_exchanges).toBe(true);
    expect((await admin.get(`/api/jobs/${jobId}/ai-exchanges`)).json().enabled).toBe(true);
  });
});
