import { useState, type FormEvent } from "react";
import { useApi } from "../lib/useApi";
import { ApiError, post, put } from "../lib/api";
import { Alert, Badge, Button, Card, Field, Input, PageTitle, Select, Spinner } from "../ui";

export interface EmailSettingsResponse {
  settings: {
    email_provider: "none" | "emailit";
    email_from: string;
    email_from_name: string;
    email_reply_to: string;
    public_url: string;
  };
  apiKeySet: boolean;
  apiKeySource: "settings" | "env" | null;
  apiKeyMasked: string | null;
  enabled: boolean;
  reason: string | null;
  effectiveFromName: string;
  effectivePublicUrl: string;
}

export function SettingsEmailPage() {
  const { data, loading, error, reload } = useApi<EmailSettingsResponse>("/api/settings/email");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [testTo, setTestTo] = useState("");

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Could not load"}</Alert>;
  const s = data.settings;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      email_provider: fd.get("email_provider"),
      email_from: fd.get("email_from"),
      email_from_name: fd.get("email_from_name"),
      email_reply_to: fd.get("email_reply_to"),
      public_url: fd.get("public_url"),
    };
    if (clearKey) body.emailit_api_key = "";
    else if (key.trim()) body.emailit_api_key = key.trim();
    setBusy(true);
    setMsg(null);
    try {
      const r = await put<EmailSettingsResponse>("/api/settings/email", body);
      setKey("");
      setClearKey(false);
      await reload();
      setMsg({ kind: "success", text: r.enabled ? "Saved. Outgoing email is on." : `Saved. Outgoing email is off${r.reason ? `: ${r.reason.toLowerCase()}` : ""}.` });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setMsg(null);
    try {
      await post("/api/settings/email/test", { to: testTo.trim() || undefined });
      setMsg({ kind: "success", text: `Test message sent${testTo.trim() ? ` to ${testTo.trim()}` : " to your address"}. Check the inbox (and spam folder).` });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Test failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle>Email</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <form onSubmit={save} className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Outgoing email"
          actions={data.enabled ? <Badge tone="green">on</Badge> : <Badge tone="slate">off{data.reason ? `: ${data.reason.toLowerCase()}` : ""}</Badge>}
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Recap emails firm users only: invite links, password-reset links, and a notice when a password changes. It never emails clients and never attaches anything from a return. Messages go out through{" "}
              <a href="https://emailit.com" target="_blank" rel="noreferrer" className="text-brand hover:underline">
                Emailit
              </a>
              ; the API key stays on this box.
            </p>
            <Field label="Provider">
              <Select name="email_provider" defaultValue={s.email_provider}>
                <option value="none">Off (admins hand out temporary passwords and invite links)</option>
                <option value="emailit">Emailit</option>
              </Select>
            </Field>
            <Field
              label="Emailit API key"
              hint={
                data.apiKeySet
                  ? data.apiKeySource === "env"
                    ? "A key is set through the EMAILIT_API_KEY environment variable. Enter one here to override it."
                    : `A key is saved (${data.apiKeyMasked}). Leave blank to keep it.`
                  : "Create a key under Emailit › Settings › API keys, limited to your sending domain."
              }
            >
              <div className="flex items-center gap-2">
                <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={data.apiKeySet ? "(unchanged)" : "em_api_..."} disabled={clearKey} />
                {data.apiKeySet && data.apiKeySource === "settings" && (
                  <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600">
                    <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove
                  </label>
                )}
              </div>
            </Field>
            <Field label="Sender address" hint="Must be on a domain verified in Emailit, e.g. recap@yourfirm.com.">
              <Input name="email_from" type="email" defaultValue={s.email_from} placeholder="recap@yourfirm.com" />
            </Field>
            <Field label="Sender name" hint={`Blank uses the firm name (currently "${data.effectiveFromName}").`}>
              <Input name="email_from_name" defaultValue={s.email_from_name} />
            </Field>
            <Field label="Reply-to (optional)" hint="Where a reply to an automated message should land, e.g. the office mailbox.">
              <Input name="email_reply_to" type="email" defaultValue={s.email_reply_to} />
            </Field>
          </div>
        </Card>
        <div className="space-y-4">
          <Card title="Links in messages">
            <div className="space-y-3">
              <Field label="Public URL" hint={`The address users open Recap at. Blank uses ${data.effectivePublicUrl || "the address of the request that triggered the message"}.`}>
                <Input name="public_url" defaultValue={s.public_url} placeholder="https://recap.yourfirm.com" />
              </Field>
            </div>
          </Card>
          <Card title="Test">
            <div className="space-y-3">
              <Field label="Send a test message to" hint="Blank sends to your own address. Save first; the test uses the saved settings.">
                <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@yourfirm.com" />
              </Field>
              <Button type="button" variant="secondary" disabled={busy || !data.enabled} onClick={sendTest}>
                Send test message
              </Button>
            </div>
          </Card>
        </div>
        <div className="lg:col-span-2">
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </>
  );
}
