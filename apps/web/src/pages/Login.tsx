import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { LoginPanel } from "@kisaesdevlab/vibe-auth/react";
import { useApi } from "../lib/useApi";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { Alert, Button, Field, Input } from "../ui";

// The package renders the "Sign in with ..." link, the divider and its notes; these make them
// look like the rest of the page. Left unset they fall back to the package's inline styles.
const PANEL_CLASSES = {
  root: "space-y-4",
  button: "block w-full rounded-md bg-brand px-3 py-2 text-center text-sm font-medium text-white hover:bg-brand-strong aria-disabled:opacity-70",
  divider: "text-center text-xs uppercase tracking-wide text-slate-400",
  note: "text-center text-sm text-slate-500",
};

/**
 * Sign-in page. Single sign-on (Q57) is driven by GET /auth/status: in `local` mode this is the
 * password form alone, in `both` a "Sign in with ..." button sits above it, and in `oidc_only`
 * the form is hidden. `breakglass` is the unlinked /login/local route, where the form shows in
 * every mode so the emergency account can get in when the identity provider is down.
 */
export function LoginPage({ breakglass = false }: { breakglass?: boolean }) {
  const { user, login, setupNeeded } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { notice?: string; from?: string } | null;
  const notice = state?.notice ?? null;
  const returnTo = state?.from ?? "/";
  const { data: reset } = useApi<{ enabled: boolean }>("/api/auth/password-reset/status");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (setupNeeded) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-xs">
        <div>
          <h1 className="text-lg font-bold text-brand">Vibe Recap</h1>
          <p className="text-sm text-slate-500">{breakglass ? "Emergency sign-in" : "Sign in to continue"}</p>
        </div>
        {notice && !error && <Alert kind="success">{notice}</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        <LoginPanel basePath="" returnTo={returnTo} breakglass={breakglass} classNames={PANEL_CLASSES}>
          <form onSubmit={submit} className="space-y-4">
            {/* The break-glass account signs in by username, which an email field would reject. */}
            <Field label={breakglass ? "Email or username" : "Email"}>
              <Input type={breakglass ? "text" : "email"} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Signing in..." : "Sign in"}
            </Button>
            {reset?.enabled && !breakglass && (
              <p className="text-center text-sm">
                <Link to="/forgot-password" className="text-brand hover:underline">
                  Forgot your password?
                </Link>
              </p>
            )}
          </form>
        </LoginPanel>
      </div>
    </div>
  );
}
