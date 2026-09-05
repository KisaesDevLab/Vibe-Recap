import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Fetch JSON from the API; optionally poll every `intervalMs`. */
export function useApi<T>(url: string | null, intervalMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (!url) return;
    try {
      const d = await get<T>(url);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    setLoading(!!url);
    void reload();
    const t = intervalMs && url ? setInterval(() => void reload(), intervalMs) : undefined;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [reload, intervalMs, url]);

  return { data, error, loading, reload };
}
