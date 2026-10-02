import { useState, type FormEvent } from "react";
import type { JobDetailDto, ShareChannel, ShareDto, ShareEventDto, SharesResponse } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { Alert, Badge, Button, Card, Field, Input, Select } from "../ui";

const STATE_TONE: Record<ShareDto["state"], "green" | "slate" | "amber" | "red"> = {
  active: "green",
  exhausted: "slate",
  expired: "slate",
  locked: "red",
  revoked: "amber",
};

const STATE_LABEL: Record<ShareDto["state"], string> = {
  active: "active",
  exhausted: "all views used",
  expired: "expired",
  locked: "locked",
  revoked: "revoked",
};

const EVENT_LABEL: Record<string, string> = {
  created: "Link sent",
  reissued: "Re-issued",
  code_sent: "Code sent",
  code_failed: "Code could not be sent",
  verify_failed: "Wrong code or last 4",
  cooldown: "Cooldown (15 min)",
  locked: "Locked",
  verified: "Verified",
  played: "Watched",
  revoked: "Revoked",
  expired: "Expired; contact erased",
  job_purged: "Job purged; contact erased",
};

/** "Chrome on Windows" from a user-agent string; good enough for a timeline. */
function browser(ua: string | null): string {
  if (!ua) return "";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

function ShareRow({ share, jobId, canManage, onChanged }: { share: ShareDto; jobId: string; canManage: boolean; onChanged: (msg?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function act(path: "revoke" | "reissue") {
    if (path === "revoke" && !confirm("Revoke this link? The client will no longer be able to open it.")) return;
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/jobs/${jobId}/shares/${share.id}/${path}`);
      onChanged(path === "reissue" ? `A new link was sent to ${share.contactMasked}; the old one no longer works.` : undefined);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATE_TONE[share.state]}>{STATE_LABEL[share.state]}</Badge>
        <span className="font-medium">{share.contactMasked}</span>
        <span className="text-slate-500">by {share.channel === "sms" ? "text" : "email"}</span>
        {share.secretRequired && <Badge tone="blue">last 4 required</Badge>}
        <span className="ml-auto flex gap-2">
          {canManage && !share.wiped && share.state !== "active" && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("reissue")} title="Send a fresh 7-day link to the same contact">
              Re-issue
            </Button>
          )}
          {canManage && share.state === "active" && (
            <>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("reissue")} title="Send a fresh 7-day link and revoke this one">
                Re-issue
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => act("revoke")}>
                Revoke
              </Button>
            </>
          )}
        </span>
      </div>
      <div className="mt-1 text-xs text-slate-500">
        Sent {fmtDate(share.createdAt)} by {share.createdByLabel} · expires {fmtDate(share.expiresAt)} · opened {share.sessionsUsed} of {share.maxSessions}
        {share.firstViewedAt ? ` · first watched ${fmtDate(share.firstViewedAt)}` : " · not watched yet"}
        {share.failedAttempts ? ` · ${share.failedAttempts} failed attempt${share.failedAttempts === 1 ? "" : "s"}` : ""}
        {share.cooldownUntil ? ` · cooling down until ${fmtDate(share.cooldownUntil)}` : ""}
        {share.revokedAt ? ` · revoked by ${share.revokedByLabel ?? "?"}` : ""}
      </div>
      {err && (
        <div className="mt-2">
          <Alert kind="error">{err}</Alert>
        </div>
      )}
    </li>
  );
}

function Timeline({ events, shares }: { events: ShareEventDto[]; shares: ShareDto[] }) {
  const contactOf = new Map(shares.map((s) => [s.id, s.contactMasked]));
  if (!events.length) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">Client activity ({events.length})</summary>
      <ol className="mt-2 space-y-1 text-xs">
        {events.map((e) => (
          <li key={e.id} className="flex flex-wrap gap-x-3">
            <span className="w-40 shrink-0 text-slate-400">{fmtDate(e.at)}</span>
            <span className="w-44 shrink-0 font-medium">{EVENT_LABEL[e.event] ?? e.event}</span>
            <span className="text-slate-500">{contactOf.get(e.shareId) ?? ""}</span>
            {e.actorLabel && e.actorLabel !== "client:share" && <span className="text-slate-500">{e.actorLabel}</span>}
            {e.ip && <span className="text-slate-500">{e.ip}</span>}
            {e.userAgent && <span className="text-slate-500" title={e.userAgent}>{browser(e.userAgent)}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function SharePanel({ job, onChanged }: { job: JobDetailDto; onChanged: () => void }) {
  const { can } = useAuth();
  const visible = can("staff") && ["approved", "released", "purged"].includes(job.status);
  const { data, error, reload } = useApi<SharesResponse>(visible ? `/api/jobs/${job.id}/shares` : null, 15000);
  const [channel, setChannel] = useState<ShareChannel>("email");
  const [contact, setContact] = useState("");
  const [requireSecret, setRequireSecret] = useState(true);
  const [last4, setLast4] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  if (!visible) return null;
  const hasVideo = job.files.some((f) => f.kind === "video" && !f.purgedAt);
  const sharing = data?.sharing;
  const canManage = can("preparer");
  const canCreate = canManage && !!sharing?.enabled && hasVideo && ["approved", "released"].includes(job.status);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/jobs/${job.id}/shares`, { channel, contact, requireSecret, last4: requireSecret ? last4 : null });
      setMsg({ kind: "success", text: `Link sent. ${job.status === "approved" ? "The job is now released. " : ""}The client gets a one-time code when they open it.` });
      setContact("");
      setLast4("");
      await reload();
      onChanged();
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Could not share" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Share with client">
      {msg && (
        <div className="mb-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      {sharing && !sharing.enabled && (
        <p className="text-sm text-slate-500">
          Client sharing is not available: {sharing.reason?.toLowerCase()}.{can("admin") ? " Set it up under Settings › Sharing." : " An admin can set it up under Settings › Sharing."}
        </p>
      )}
      {canCreate && (
        <form onSubmit={create} className="space-y-3">
          <p className="text-sm text-slate-600">
            The client gets a link that works for 7 days. Before the video plays they ask for a one-time code, which goes to this {channel === "sms" ? "number" : "address"}, and the video can be opened 5 times.
            Nothing about the return is in the message.
          </p>
          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <Field label="Send by">
              <Select value={channel} onChange={(e) => setChannel(e.target.value as ShareChannel)}>
                <option value="email" disabled={!sharing?.channels.email}>
                  Email{sharing?.channels.email ? "" : " (off)"}
                </option>
                <option value="sms" disabled={!sharing?.channels.sms}>
                  Text{sharing?.channels.sms ? "" : " (off)"}
                </option>
              </Select>
            </Field>
            <Field label={channel === "sms" ? "Client's mobile number" : "Client's email"}>
              <Input
                type={channel === "sms" ? "tel" : "email"}
                autoComplete="off"
                required
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder={channel === "sms" ? "(555) 123-4567" : "client@example.com"}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requireSecret} onChange={(e) => setRequireSecret(e.target.checked)} /> Also ask for the last four digits of the client's SSN
          </label>
          {requireSecret && (
            <Field label="Last four digits of the SSN" hint="Kept only as a one-way hash on this share, erased when the link expires.">
              <Input className="max-w-[8rem]" type="password" inputMode="numeric" autoComplete="off" maxLength={4} pattern="[0-9]{4}" required value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))} />
            </Field>
          )}
          <Button type="submit" disabled={busy || !contact.trim() || (requireSecret && last4.length !== 4)}>
            Send link
          </Button>
        </form>
      )}
      {data && data.shares.length > 0 && (
        <>
          <ul className="mt-4 space-y-2">
            {data.shares.map((s) => (
              <ShareRow
                key={s.id}
                share={s}
                jobId={job.id}
                canManage={canManage && !!sharing?.enabled}
                onChanged={(text) => {
                  if (text) setMsg({ kind: "success", text });
                  void reload();
                }}
              />
            ))}
          </ul>
          <Timeline events={data.events} shares={data.shares} />
        </>
      )}
    </Card>
  );
}
