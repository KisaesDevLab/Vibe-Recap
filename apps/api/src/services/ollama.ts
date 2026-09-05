export interface OllamaStatus {
  reachable: boolean;
  models: string[];
}

export async function ollamaStatus(baseUrl: string, timeoutMs = 3000): Promise<OllamaStatus> {
  try {
    const res = await fetch(new URL("/api/tags", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, models: [] };
    const body = (await res.json()) as { models?: { name: string }[] };
    return { reachable: true, models: (body.models ?? []).map((m) => m.name) };
  } catch {
    return { reachable: false, models: [] };
  }
}
