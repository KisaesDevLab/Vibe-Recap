import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeResponse, Role, UserDto } from "@vibe-recap/shared";
import { roleAtLeast } from "@vibe-recap/shared";
import { ApiError, get, post, setCsrfToken } from "./api";

interface AuthState {
  user: UserDto | null;
  loading: boolean;
  setupNeeded: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (min: Role) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupNeeded, setSetupNeeded] = useState(false);
  // True when the session came from single sign-on (Q57); decides how sign-out happens.
  const [sso, setSso] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await get<MeResponse>("/api/auth/me");
      setCsrfToken(me.csrfToken);
      setUser(me.user);
      setSso(me.sso);
      setSetupNeeded(false);
    } catch (err) {
      setCsrfToken(null);
      setUser(null);
      if (err instanceof ApiError && err.status === 401) {
        const status = await get<{ needed: boolean }>("/api/setup/status").catch(() => ({ needed: false }));
        setSetupNeeded(status.needed);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const me = await post<MeResponse>("/api/auth/login", { email, password });
    setCsrfToken(me.csrfToken);
    setUser(me.user);
    setSso(false);
    setSetupNeeded(false);
  }, []);

  const logout = useCallback(async () => {
    if (sso) {
      // A full navigation: the package ends this session, audits it, and lands on /login.
      // local=1 signs out of Recap only; the other Vibe apps stay signed in at the identity provider.
      window.location.assign("/auth/oidc/logout?local=1");
      return new Promise<void>(() => {});
    }
    try {
      await post("/api/auth/logout");
    } finally {
      setCsrfToken(null);
      setUser(null);
    }
  }, [sso]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      setupNeeded,
      refresh,
      login,
      logout,
      can: (min) => (user ? roleAtLeast(user.role, min) : false),
    }),
    [user, loading, setupNeeded, refresh, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
