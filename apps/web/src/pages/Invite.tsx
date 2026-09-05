import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { Alert, Button, Field, Input, Spinner } from "../ui";

export function InvitePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { data, loading, error } = useApi<{ email: string; name: string; role: string }>(token ? `/api/invite/${token}` : null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setMsg("Passwords do not match");
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/invite/${token}`, { password });
      navigate("/login");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Could not accept the invite");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-xs">
        <div>
          <h1 className="text-lg font-bold text-brand">Vibe Recap</h1>
          <p className="text-sm text-slate-500">Set a password for your account</p>
        </div>
        {loading ? (
          <Spinner />
        ) : error || !data ? (
          <Alert kind="error">{error ?? "This invite link is invalid or has expired."}</Alert>
        ) : (
          <>
            <p className="text-sm">
              {data.name} · {data.email} · <span className="text-slate-500">{data.role}</span>
            </p>
            {msg && <Alert kind="error">{msg}</Alert>}
            <Field label="Password" hint="At least 12 characters. Common passwords are rejected.">
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoFocus />
            </Field>
            <Field label="Confirm password">
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Field>
            <Button type="submit" disabled={busy} className="w-full">
              Set password and sign in
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
