import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { Alert, Button, Field, Input, Spinner } from "../ui";

export function ForgotPasswordPage() {
  const { user } = useAuth();
  const { data, loading } = useApi<{ enabled: boolean }>("/api/auth/password-reset/status");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/auth/forgot-password", { email });
      setDone(r.message);
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 429 ? "Too many requests. Wait a few minutes and try again." : err.message) : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-xs">
        <div>
          <h1 className="text-lg font-bold text-brand">Vibe Recap</h1>
          <p className="text-sm text-slate-500">Reset your password</p>
        </div>
        {loading ? (
          <Spinner />
        ) : !data?.enabled ? (
          <Alert kind="info">Password reset by email is not enabled on this installation. Ask an administrator to reset your password; they can hand you a temporary one from Settings › Users.</Alert>
        ) : done ? (
          <Alert kind="success">{done}</Alert>
        ) : (
          <>
            {error && <Alert kind="error">{error}</Alert>}
            <p className="text-sm text-slate-600">Enter the email address of your account. If it exists, a one-hour link to choose a new password is sent there.</p>
            <Field label="Email">
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Sending..." : "Send reset link"}
            </Button>
          </>
        )}
        <p className="text-center text-sm">
          <Link to="/login" className="text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
