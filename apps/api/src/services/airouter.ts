/**
 * Vibe AI Router (Q37): task-class registration at startup and a connection probe.
 *
 * Contract: Vibe-AI-Router docs/integration.md. Registration is idempotent and version
 * stamped; a class the router has never seen starts `local_only` until the firm admin widens
 * it in the router console. The API registers because it boots first and has the token; the
 * worker only calls completions.
 */
import type { FastifyInstance } from "fastify";

export const RECAP_TASK_CLASSES = [
  {
    key: "recap_script",
    description: "Plain-English narration script for a client's Form 1040 recap video. Input: extracted figures, first names, filing status, states, preparer note. No SSNs, addresses, or account numbers.",
    requires: {},
    defaultMaxTokens: 1200,
  },
];

export interface RouterProbe {
  configured: boolean;
  url: string;
  reachable: boolean;
  registered: Array<{ key: string; created: boolean; sensitivity: string }> | null;
  error: string | null;
}

export async function registerTaskClasses(app: FastifyInstance): Promise<RouterProbe> {
  const url = app.config.VIBE_AI_ROUTER_URL.replace(/\/$/, "");
  const token = app.config.VIBE_AI_TOKEN;
  const out: RouterProbe = { configured: !!token, url, reachable: false, registered: null, error: null };
  if (!token) {
    out.error = "VIBE_AI_TOKEN is empty; script generation uses the bundled Ollama";
    return out;
  }
  try {
    const health = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
    out.reachable = health.ok;
  } catch (err) {
    out.error = `router unreachable at ${url} (${(err as Error).message})`;
    return out;
  }
  try {
    const res = await fetch(`${url}/v1/task-classes/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ app: "vibe-recap", version: app.config.RECAP_VERSION, classes: RECAP_TASK_CLASSES }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      out.error = `registration failed: ${body.error?.code ?? res.status} ${body.error?.message ?? ""}`.trim();
      return out;
    }
    const data = (await res.json()) as { registered: RouterProbe["registered"] };
    out.registered = data.registered;
  } catch (err) {
    out.error = `registration failed (${(err as Error).message})`;
  }
  return out;
}
