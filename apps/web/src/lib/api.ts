export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}
export function getCsrfToken() {
  return csrfToken;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function buildHeaders(method: string, body: unknown, token: string | null, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { accept: "application/json", ...extra };
  if (body !== undefined && !(body instanceof FormData)) headers["content-type"] = "application/json";
  if (STATE_CHANGING.has(method.toUpperCase()) && token) headers["x-csrf-token"] = token;
  return headers;
}

export async function api<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: buildHeaders(method, body, csrfToken, opts.headers),
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data ?? { error: "http", message: `${res.status} ${res.statusText}` });
  }
  return data as T;
}

export const get = <T = unknown>(url: string, opts?: { signal?: AbortSignal }) => api<T>("GET", url, undefined, opts);
export const post = <T = unknown>(url: string, body?: unknown) => api<T>("POST", url, body);
export const put = <T = unknown>(url: string, body?: unknown) => api<T>("PUT", url, body);
export const patch = <T = unknown>(url: string, body?: unknown) => api<T>("PATCH", url, body);
export const del = <T = unknown>(url: string, body?: unknown) => api<T>("DELETE", url, body);
