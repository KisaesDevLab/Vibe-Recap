import { useState } from "react";
import type { JobDetailDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Alert, Badge, Button, Card, Input, Textarea } from "../ui";

function DeliveredBox({ job, onChanged }: { job: JobDetailDto; onChanged: () => void }) {
  const [note, setNote] = useState(job.deliveredNote ?? "");
  const [busy, setBusy] = useState(false);
  async function save(delivered: boolean) {
    setBusy(true);
    try {
      await patch(`/api/jobs/${job.id}/delivered`, { delivered, note: note || null });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={job.delivered} disabled={busy} onChange={(e) => save(e.target.checked)} /> Delivered to client
      </label>
      <Input className="max-w-xs" placeholder="e.g. sent via portal 9/12" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => job.delivered && save(true)} />
      <span className="text-xs text-slate-500">Your own tracking note; recorded in the audit log.</span>
    </div>
  );
}

export function VideoPanel({ job, onChanged }: { job: JobDetailDto; onChanged: () => void }) {
  const { user, can } = useAuth();
  const { data: approval } = useApi<{ ok: boolean; reason?: string }>(can("staff") ? `/api/jobs/${job.id}/approval` : null, 5000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [captions, setCaptions] = useState(true);

  const hasVideo = job.files.some((f) => f.kind === "video" && !f.purgedAt);
  const role = user?.role ?? "viewer";
  const canSee = hasVideo && (can("preparer") || (role === "staff" && ["approved", "released"].includes(job.status)) || (role === "viewer" && job.status === "released"));

  async function act(url: string, body?: unknown, okText?: string) {
    setBusy(true);
    setMsg(null);
    try {
      await post(url, body);
      if (okText) setMsg({ kind: "success", text: okText });
      setRejecting(false);
      setReason("");
      onChanged();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  }

  const reviewer = can("preparer");
  const approveDisabled = busy || !approval?.ok;

  return (
    <Card
      title="Video"
      actions={
        reviewer ? (
          <>
            {["rejected", "failed"].includes(job.status) && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/rerender`, undefined, "Re-rendering from narration.")}>
                Re-render
              </Button>
            )}
            {["needs_review", "approved"].includes(job.status) && (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => setRejecting((v) => !v)}>
                Reject
              </Button>
            )}
            {job.status === "needs_review" && (
              <Button size="sm" disabled={approveDisabled} title={approval?.ok ? "Snapshot the script, extraction, and verification and approve" : approval?.reason} onClick={() => act(`/api/jobs/${job.id}/approve`, undefined, "Approved. Release it when you are ready to download.")}>
                Approve
              </Button>
            )}
            {job.status === "approved" && (
              <Button size="sm" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/release`, undefined, "Released. Download the package and send it through your usual channel.")}>
                Release
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {msg && (
        <div className="mb-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {job.status === "needs_review" && approval && !approval.ok && (
        <div className="mb-3">
          <Alert kind="warning">Approve is disabled: {approval.reason}</Alert>
        </div>
      )}
      {job.status === "rejected" && job.rejectedReason && (
        <div className="mb-3">
          <Alert kind="warning">Rejected: {job.rejectedReason}. Edit the script or re-render, then review again.</Alert>
        </div>
      )}
      {job.status === "approved" && (
        <div className="mb-3">
          <Alert kind="success">Approved {job.approvedAt ? new Date(job.approvedAt).toLocaleString() : ""}. Release to make it downloadable.</Alert>
        </div>
      )}
      {rejecting && (
        <div className="mb-3 space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
          <Textarea rows={2} placeholder="What needs to change? (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => act(`/api/jobs/${job.id}/reject`, { reason }, "Rejected. Edit the script and re-render.")}>
            Confirm reject
          </Button>
        </div>
      )}
      {!hasVideo ? (
        <p className="text-sm text-slate-500">No video yet. It is rendered after the script passes validation and verification.</p>
      ) : !canSee ? (
        <p className="text-sm text-slate-500">The video becomes visible to your role after {role === "viewer" ? "release" : "approval"}.</p>
      ) : (
        <div>
          <video key={job.updatedAt} controls className="w-full rounded-md bg-black" preload="metadata" crossOrigin="use-credentials">
            <source src={`/api/jobs/${job.id}/preview.mp4`} type="video/mp4" />
            {captions && <track kind="captions" srcLang="en" label="English" src={`/api/jobs/${job.id}/preview.vtt`} default />}
          </video>
          <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} /> captions
            </label>
            <a href={`/api/jobs/${job.id}/preview.txt`} target="_blank" rel="noreferrer" className="text-brand hover:underline">
              transcript
            </a>
            {job.reconExceptionCount ? <Badge tone="amber">recon exception on this job</Badge> : null}
          </div>
          {(job.status === "released" || (can("preparer") && job.status === "approved")) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <a href={`/api/jobs/${job.id}/package.zip`} className="inline-flex rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong">
                Download package (MP4 + captions + transcript)
              </a>
              <a href={`/api/jobs/${job.id}/download/mp4`} className="text-brand hover:underline">MP4</a>
              <a href={`/api/jobs/${job.id}/download/vtt`} className="text-brand hover:underline">VTT</a>
              <a href={`/api/jobs/${job.id}/download/txt`} className="text-brand hover:underline">TXT</a>
              {can("preparer") && (
                <>
                  <a href={`/api/jobs/${job.id}/download/extraction`} className="text-slate-500 hover:underline">extraction.json</a>
                  <a href={`/api/jobs/${job.id}/download/verification`} className="text-slate-500 hover:underline">verification.json</a>
                  <a href={`/api/jobs/${job.id}/download/source`} className="text-slate-500 hover:underline">source PDF</a>
                </>
              )}
            </div>
          )}
          {job.status === "released" && can("staff") && (
            <DeliveredBox job={job} onChanged={onChanged} />
          )}
        </div>
      )}
    </Card>
  );
}
