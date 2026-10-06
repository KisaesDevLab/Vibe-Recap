import { useState, type FormEvent } from "react";
import { useApi } from "../lib/useApi";
import { ApiError, post, put } from "../lib/api";
import { Alert, Badge, Button, Card, Field, Input, PageTitle, Select, Spinner } from "../ui";

interface SharingSettingsResponse {
  settings: {
    share_enabled: boolean;
    share_public_url: string;
    share_return_label: string;
    sms_provider: "" | "none" | "twilio";
    twilio_account_sid: string;
    twilio_from: string;
  };
  authTokenSet: boolean;
  authTokenSource: "settings" | "env" | null;
  authTokenMasked: string | null;
  envSms: { provider: string; accountSidSet: boolean; fromSet: boolean };
  effectivePublicUrl: string;
  envPublicUrl: string;
  status: {
    enabled: boolean;
    reason: string | null;
    channels: { email: boolean; sms: boolean };
    channelReasons: { email: string | null; sms: string | null };
  };
}

export function SettingsSharingPage() {
  const { data, loading, error, reload } = useApi<SharingSettingsResponse>("/api/settings/sharing");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [testTo, setTestTo] = useState("");

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Could not load"}</Alert>;
  const s = data.settings;
  const st = data.status;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      share_enabled: fd.get("share_enabled") === "on",
      share_public_url: fd.get("share_public_url"),
      share_return_label: fd.get("share_return_label"),
      sms_provider: fd.get("sms_provider"),
      twilio_account_sid: fd.get("twilio_account_sid"),
      twilio_from: fd.get("twilio_from"),
    };
    if (clearToken) body.twilio_auth_token = "";
    else if (token.trim()) body.twilio_auth_token = token.trim();
    setBusy(true);
    setMsg(null);
    try {
      const r = await put<SharingSettingsResponse>("/api/settings/sharing", body);
      setToken("");
      setClearToken(false);
      await reload();
      setMsg({ kind: "success", text: r.status.enabled ? "Saved. Client sharing is on." : `Saved. Client sharing is off${r.status.reason ? `: ${r.status.reason.toLowerCase()}` : ""}.` });
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
      await post("/api/settings/sharing/test-sms", { to: testTo });
      setMsg({ kind: "success", text: "Test text sent." });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Test failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle>Sharing</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <form onSubmit={save} className="grid gap-4 lg:grid-cols-2">
        <Card title="Client sharing" actions={st.enabled ? <Badge tone="green">on</Badge> : <Badge tone="slate">off{st.reason ? `: ${st.reason.toLowerCase()}` : ""}</Badge>}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              A preparer can send an approved video to the client as a link that works for 7 days. Before it plays, the client gets a one-time code by email or text at
              the address the preparer entered, and optionally confirms the last four digits of their SSN. Each link opens at most 5 times; wrong answers cool down
              after 3 tries and lock the link after 10. The page is served through a Cloudflare tunnel on its own hostname, and only the watch page is reachable there.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="share_enabled" defaultChecked={s.share_enabled} /> Let preparers share videos with clients
            </label>
            <Field
              label="Watch address"
              hint={
                data.envPublicUrl && !s.share_public_url
                  ? `Blank uses ${data.envPublicUrl} from SHARE_PUBLIC_URL.`
                  : "The public hostname your Cloudflare tunnel routes to this box, e.g. https://watch.yourfirm.com. It must differ from the staff address. See docs/sharing.md."
              }
            >
              <Input name="share_public_url" defaultValue={s.share_public_url} placeholder="https://watch.yourfirm.com" />
            </Field>
            <Field label="Return link button" hint="The button the client sees under the video when the preparer adds a tax return / e-sign link to the share. Blank uses the default.">
              <Input name="share_return_label" defaultValue={s.share_return_label} maxLength={60} placeholder="Review and sign your return" />
            </Field>
            <div className="text-sm text-slate-600">
              Email: {st.channels.email ? <Badge tone="green">ready</Badge> : <Badge tone="slate">{(st.channelReasons.email ?? "off").toLowerCase()}</Badge>}{" "}
              <span className="text-xs text-slate-500">(Settings › Email)</span>
            </div>
          </div>
        </Card>
        <div className="space-y-4">
          <Card title="Text messages (Twilio)" actions={st.channels.sms ? <Badge tone="green">on</Badge> : <Badge tone="slate">{(st.channelReasons.sms ?? "off").toLowerCase()}</Badge>}>
            <div className="space-y-3">
              <Field
                label="Provider"
                hint="On the Vibe Appliance, Twilio entered once under Configuration › Email & SMS reaches Recap through the environment; leave the fields below blank to use it."
              >
                <Select name="sms_provider" defaultValue={s.sms_provider}>
                  <option value="">
                    From the environment ({data.envSms.provider === "twilio" ? `Twilio${data.envSms.accountSidSet && data.envSms.fromSet ? "" : ", incomplete"}` : "off"})
                  </option>
                  <option value="none">Off</option>
                  <option value="twilio">Twilio</option>
                </Select>
              </Field>
              <Field label="Account SID">
                <Input name="twilio_account_sid" defaultValue={s.twilio_account_sid} placeholder="AC…" autoComplete="off" />
              </Field>
              <Field
                label="Auth token"
                hint={
                  data.authTokenSet
                    ? data.authTokenSource === "env"
                      ? "A token is set through TWILIO_AUTH_TOKEN. Enter one here to override it."
                      : `A token is saved (${data.authTokenMasked}). Leave blank to keep it.`
                    : "From the Twilio console. It stays on this box and is never exported."
                }
              >
                <div className="flex items-center gap-2">
                  <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.authTokenSet ? "(unchanged)" : ""} disabled={clearToken} />
                  {data.authTokenSet && data.authTokenSource === "settings" && (
                    <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600">
                      <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} /> Remove
                    </label>
                  )}
                </div>
              </Field>
              <Field label="Send from" hint="Your Twilio number (+15551234567) or a Messaging Service SID (MG…). US numbers need A2P 10DLC registration.">
                <Input name="twilio_from" defaultValue={s.twilio_from} placeholder="+15551234567" autoComplete="off" />
              </Field>
            </div>
          </Card>
          <Card title="Test text">
            <div className="space-y-3">
              <Field label="Send a test text to" hint="Your own mobile. Save first; the test uses the saved settings.">
                <Input type="tel" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="(555) 123-4567" />
              </Field>
              <Button type="button" variant="secondary" disabled={busy || !st.channels.sms || !testTo.trim()} onClick={sendTest}>
                Send test text
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
