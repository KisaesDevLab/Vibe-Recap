import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "../lib/auth";
import { ApiError, post, put } from "../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, Select } from "../ui";
import { VOICES } from "@vibe-recap/shared";

/** Every role: who am I, and change my password. Forced here while must-change-password is set. */
export function AccountPage() {
  const { user, refresh } = useAuth();
  const [params] = useSearchParams();
  const required = params.get("required") === "1" || !!user?.mustChangePassword;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState(user?.voice ?? "");
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);

  async function saveVoice(e: FormEvent) {
    e.preventDefault();
    setVoiceBusy(true);
    setVoiceMsg(null);
    try {
      await put("/api/auth/preferences", { voice: voice || null });
      await refresh();
      setVoiceMsg(voice ? `Your recaps will be narrated by ${VOICES[voice as keyof typeof VOICES]}.` : "Your recaps will use the firm's default voice.");
    } catch (err) {
      setVoiceMsg(err instanceof ApiError ? err.message : "Could not save the voice");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setMsg({ kind: "error", text: "New passwords do not match" });
    if (next === current) return setMsg({ kind: "error", text: "Choose a password you have not used here before" });
    setBusy(true);
    setMsg(null);
    try {
      await post("/api/auth/change-password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      await refresh();
      setMsg({ kind: "success", text: "Password changed. Every other sign-in for your account has been ended." });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Could not change the password" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle>Your account</PageTitle>
      {required && !msg && (
        <div className="mb-4">
          <Alert kind="warning">Your password was set by an administrator. Choose your own before continuing.</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Signed in as">
          <dl className="grid grid-cols-[100px_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">Name</dt>
            <dd>{user?.name}</dd>
            <dt className="text-slate-500">Email</dt>
            <dd>{user?.email}</dd>
            <dt className="text-slate-500">Role</dt>
            <dd>{user?.role}</dd>
          </dl>
          <p className="mt-4 text-xs text-slate-500">Name, email, and role are managed by an administrator under Settings › Users.</p>
        </Card>
        <Card title="Narration voice">
          <form onSubmit={saveVoice} className="space-y-3">
            <Field label="Voice" hint="Used for the recaps you upload. The firm default applies until you choose one.">
              <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
                <option value="">Firm default</option>
                {Object.entries(VOICES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={voiceBusy}>
              {voiceBusy ? "Saving..." : "Save voice"}
            </Button>
            {voiceMsg && <p className="text-xs text-slate-500">{voiceMsg}</p>}
            <p className="text-xs text-slate-500">Takes effect on the next recap you queue, and on any recap you re-render.</p>
          </form>
        </Card>
        <Card title="Change password">
          <form onSubmit={submit} className="space-y-3">
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus={required} />
            </Field>
            <Field label="New password" hint="At least 12 characters. Common passwords are rejected.">
              <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
            </Field>
            <Field label="Confirm new password">
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </Field>
            <Button type="submit" disabled={busy}>
              {busy ? "Changing..." : "Change password"}
            </Button>
            <p className="text-xs text-slate-500">Changing your password signs you out everywhere else. This browser stays signed in.</p>
          </form>
        </Card>
      </div>
    </>
  );
}
