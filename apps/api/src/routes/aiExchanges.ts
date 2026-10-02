import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AiAttemptDto, AiExchangeRunDto, AiExchangesResponse } from "@vibe-recap/shared";
import { files, type FileRow } from "../db/schema.js";
import { notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { getSetting } from "../services/settings.js";
import { loadJob } from "./jobs.js";

/** Stored shape, written by worker/recap/script/generate.py (_capture, _store_capture). */
interface StoredAttempt {
  attempt?: number;
  at?: string;
  model?: string | null;
  finish_reason?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  ms?: number | null;
  ok?: boolean;
  words?: number;
  errors?: string[];
  request?: Array<{ role?: string; content?: unknown }>;
  response?: string;
}
interface StoredRun {
  run?: string;
  provider?: string;
  at?: string;
  attempts?: StoredAttempt[];
}

function toAttempt(a: StoredAttempt, full: boolean): AiAttemptDto {
  const out: AiAttemptDto = {
    attempt: a.attempt ?? 0,
    at: a.at ?? null,
    model: a.model ?? null,
    finishReason: a.finish_reason ?? null,
    promptTokens: a.prompt_tokens ?? null,
    completionTokens: a.completion_tokens ?? null,
    ms: a.ms ?? null,
    ok: a.ok === true,
    words: a.words ?? 0,
    errors: Array.isArray(a.errors) ? a.errors.map(String) : [],
  };
  if (full) {
    out.request = (a.request ?? []).map((m) => ({ role: String(m.role ?? ""), content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }));
    out.response = a.response ?? "";
  }
  return out;
}

async function readRun(app: FastifyInstance, row: FileRow, full: boolean): Promise<AiExchangeRunDto> {
  const base = { fileId: row.id, seq: row.seq, purged: row.purgedAt !== null };
  if (row.purgedAt) return { ...base, run: "generate", provider: "", at: row.createdAt.toISOString(), attempts: [] };
  const doc = JSON.parse(Buffer.from(await app.storage.get(row.path, row.keyPath)).toString("utf-8")) as StoredRun;
  return {
    ...base,
    run: doc.run === "revision" ? "revision" : "generate",
    provider: doc.provider ?? "",
    at: doc.at ?? row.createdAt.toISOString(),
    attempts: (doc.attempts ?? []).map((a) => toAttempt(a, full)),
  };
}

/**
 * The job page's "AI exchanges" viewer. The list carries metadata only (models, tokens, validator
 * errors — the same detail job events already hold); the full prompt and reply come one run at a
 * time from the second route, preparer and up like the source PDF, and every such read is audited.
 */
export async function aiExchangeRoutes(app: FastifyInstance) {
  app.get("/api/jobs/:id/ai-exchanges", { preHandler: requireRole("preparer") }, async (req): Promise<AiExchangesResponse> => {
    const { id } = req.params as { id: string };
    await loadJob(app.db, id);
    const rows = await app.db
      .select()
      .from(files)
      .where(and(eq(files.jobId, id), eq(files.kind, "ai_exchange")))
      .orderBy(asc(files.seq));
    const runs: AiExchangeRunDto[] = [];
    for (const r of rows) runs.push(await readRun(app, r, false));
    return { enabled: (await getSetting(app.db, "capture_ai_exchanges")) === true, runs };
  });

  app.get("/api/jobs/:id/ai-exchanges/:fileId", { preHandler: requireRole("preparer") }, async (req): Promise<AiExchangeRunDto> => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    await loadJob(app.db, id);
    if (!z.string().uuid().safeParse(fileId).success) throw notFound("AI exchange not found");
    const [row] = await app.db
      .select()
      .from(files)
      .where(and(eq(files.jobId, id), eq(files.kind, "ai_exchange"), eq(files.id, fileId)))
      .limit(1);
    if (!row) throw notFound("AI exchange not found");
    if (row.purgedAt) throw notFound("This AI exchange was purged by retention");
    const run = await readRun(app, row, true);
    await audit(app.db, { actor: actorOf(req), action: "file.read", target: { type: "job", id }, ip: req.ip, meta: { kind: "ai_exchange", sha256: row.sha256, seq: row.seq } });
    return run;
  });
}
