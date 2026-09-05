import { useState, type FormEvent } from "react";
import { useApi } from "../lib/useApi";
import { ApiError, post, put } from "../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, Spinner } from "../ui";

interface RetentionResponse {
  settings: { retention_source_days: number; retention_extraction_days: number; retention_video_days: number; retention_failed_days: number };
  report: { dueByKind: Record<string, number>; dueNow: number; legalHoldClients: number; feedbackHoldJobs: number };
}

const FIELDS: Array<{ key: keyof RetentionResponse["settings"]; label: string; help: string }> = [
  { key: "retention_source_days", label: "Source PDFs (days after processing)", help: "The uploaded return and any prior-year PDF. 0 deletes them as soon as the job is ready for review. Default 30." },
  { key: "retention_extraction_days", label: "Extraction and script (days after release)", help: "extraction.json, script, and verification. These are what you approved; keep them as long as your document retention policy requires. Default 365." },
  { key: "retention_video_days", label: "Videos (days after release)", help: "MP4, captions, transcript, narration audio, and slide images. Default 90." },
  { key: "retention_failed_days", label: "Failed jobs (days)", help: "Everything on a job that failed and was never retried. Default 7." },
];

export function SettingsRetentionPage() {
  const { data, loading, error, reload } = useApi<RetentionResponse>("/api/settings/retention");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ purgedFiles?: number; preview: Array<{ jobId: string; kind: string; reason: string }>; skippedLegalHold: number; skippedFeedbackHold: number } | null>(null);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Could not load"}</Alert>;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, number> = {};
    for (const f of FIELDS) body[f.key] = Number(fd.get(f.key));
    setBusy(true);
    setMsg(null);
    try {
      await put("/api/settings/retention", body);
      await reload();
      setMsg({ kind: "success", text: "Saved. The hourly purge applies the new windows on its next run." });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function purgeNow(confirm: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ dryRun: boolean; purgedFiles: number; purgedJobs: number; skippedLegalHold: number; skippedFeedbackHold: number; preview: Array<{ jobId: string; kind: string; reason: string }> }>("/api/settings/retention/purge-now", { confirm });
      if (r.dryRun) setPreview({ preview: r.preview, skippedLegalHold: r.skippedLegalHold, skippedFeedbackHold: r.skippedFeedbackHold });
      else {
        setPreview(null);
        setMsg({ kind: "success", text: `Purged ${r.purgedFiles} file(s) across ${r.purgedJobs} job(s).` });
        await reload();
      }
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Purge failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle>Retention</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Firm defaults">
          <form onSubmit={save} className="space-y-4">
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.help}>
                <Input name={f.key} type="number" min={0} max={3650} defaultValue={data.settings[f.key]} required />
              </Field>
            ))}
            <p className="text-xs text-slate-500">Per-client overrides and legal holds are set on the client page. The audit log is never purged by policy.</p>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </form>
        </Card>
        <div className="space-y-4">
          <Card title="Due in the next 7 days">
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(data.report.dueByKind).map(([kind, n]) => (
                  <tr key={kind} className="border-t border-slate-100">
                    <td className="py-1 text-slate-600">{kind}</td>
                    <td className="py-1 text-right font-mono">{n}</td>
                  </tr>
                ))}
                {Object.keys(data.report.dueByKind).length === 0 && (
                  <tr>
                    <td className="py-2 text-slate-500">Nothing due.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              Due right now: {data.report.dueNow}. Clients on legal hold: {data.report.legalHoldClients}. Jobs held for feedback review: {data.report.feedbackHoldJobs}.{" "}
              <a href="/api/settings/retention/report.csv" className="text-brand hover:underline">
                Download CSV
              </a>
            </p>
          </Card>
          <Card title="Purge now">
            <p className="mb-3 text-sm text-slate-600">Runs the same code as the hourly job. Preview first; nothing is deleted until you confirm.</p>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => purgeNow(false)}>
                Preview
              </Button>
              {preview && (
                <Button variant="danger" disabled={busy} onClick={() => purgeNow(true)}>
                  Purge {preview.preview.length} file(s) now
                </Button>
              )}
            </div>
            {preview && (
              <div className="mt-3 max-h-64 overflow-auto rounded-md border border-slate-200 text-xs">
                {preview.preview.length === 0 ? (
                  <p className="p-2 text-slate-500">Nothing is due.</p>
                ) : (
                  <table className="w-full">
                    <tbody>
                      {preview.preview.map((p, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="p-1 font-mono">{p.jobId.slice(0, 8)}</td>
                          <td className="p-1">{p.kind}</td>
                          <td className="p-1 text-slate-600">{p.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {preview.skippedLegalHold > 0 && <p className="p-2 text-amber-700">{preview.skippedLegalHold} file(s) skipped because of legal holds.</p>}
                {preview.skippedFeedbackHold > 0 && <p className="p-2 text-amber-700">{preview.skippedFeedbackHold} file(s) kept because a thumbs-down holds the job (Settings › Quality).</p>}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
