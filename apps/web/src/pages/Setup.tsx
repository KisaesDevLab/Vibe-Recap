import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { ApiError, post } from "../lib/api";
import { Alert, Button, Field, Input } from "../ui";

export function SetupPage() {
  const { setupNeeded, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && !setupNeeded) return <Navigate to="/login" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/api/setup", { email, name, password });
      await refresh();
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-xs">
        <div>
          <h1 className="text-lg font-bold text-brand">Welcome to Vibe Recap</h1>
          <p className="text-sm text-slate-500">Create the first administrator account. This page disappears afterwards.</p>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Email">
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" hint="At least 12 characters. Common passwords are rejected.">
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating..." : "Create administrator"}
        </Button>
      </form>
    </div>
  );
}
