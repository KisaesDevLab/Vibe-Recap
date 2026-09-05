import { useState } from "react";
import { Link, useParams } from "react-router";
import type { JobDetailDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtBytes, fmtDate } from "../lib/format";
import { StatusBadge } from "../components/JobTable";
import { ExtractionPanel } from "../components/ExtractionPanel";
import { ScriptEditor } from "../components/ScriptEditor";
import { VerificationPanel } from "../components/VerificationPanel";
import { VideoPanel } from "../components/VideoPanel";
import type { ExtractionResponse } from "@vibe-recap/shared";
import { Alert, Button, Card, PageTitle, Spinner } from "../ui";

export function JobPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: job, error, loading, reload } = useApi<JobDetailDto>(id ? `/api/jobs/${id}` : null, 4000);
  const { data: extractionRes } = useApi<ExtractionResponse>(id ? `/api/jobs/${id}/extraction` : null, 10000);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !job) return <Spinner />;
  if (error || !job) return <Alert kind="error">{error ?? "Job not found"}</Alert>;

  async function act(url: string, body?: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      await post(url, body);
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle
        actions={
          job.status === "failed" && can("staff") ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(`/api/jobs/${job.id}/retry`)}>
              Retry from {job.errorStep ?? "start"}
            </Button>
          ) : undefined
        }
      >
        <span className="flex items-center gap-3">
          <Link to={`/clients/${job.clientId}`} className="hover:underline">
            {job.clientName}
          </Link>
          <span className="text-slate-400">{job.taxYear}</span>
          <StatusBadge status={job.status} />
        </span>
      </PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind="error">{msg}</Alert>
        </div>
      )}
      {job.status === "failed" && (
        <div className="mb-4">
          <Alert kind="error">
            Failed at <strong>{job.errorStep}</strong>: {job.errorMessage}
          </Alert>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-4 md:col-span-2">
          <Card title="Status timeline">
            <ol className="space-y-1 text-sm">
              {job.events.map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="w-40 shrink-0 text-slate-400">{fmtDate(e.at)}</span>
                  <span className="w-24 shrink-0 font-medium">{e.status}</span>
                  <span className="w-20 shrink-0 text-slate-500">{e.step ?? ""}</span>
                  <span className="text-slate-700">{e.message ?? ""}</span>
                </li>
              ))}
              {job.events.length === 0 && <li className="text-slate-500">Queued; waiting for the worker.</li>}
            </ol>
          </Card>
          <VideoPanel job={job} onChanged={() => void reload()} />
          <ScriptEditor job={job} extraction={extractionRes?.extraction ?? null} onChanged={() => void reload()} />
          <VerificationPanel job={job} />
          <ExtractionPanel job={job} onChanged={() => void reload()} />
        </div>
        <div className="space-y-4">
          <Card title="Details">
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-slate-500">Job id</dt>
              <dd className="font-mono text-xs">{job.id}</dd>
              <dt className="text-slate-500">Software</dt>
              <dd>{job.software ?? "unknown"}</dd>
              <dt className="text-slate-500">Pages</dt>
              <dd>{job.pageCount ?? ""}</dd>
              <dt className="text-slate-500">Uploaded</dt>
              <dd>
                {fmtDate(job.createdAt)}
                <br />
                <span className="text-slate-500">{job.uploadedBy}</span>
              </dd>
              {job.batchId && (
                <>
                  <dt className="text-slate-500">Batch</dt>
                  <dd>
                    <Link to={`/batches/${job.batchId}`} className="text-brand hover:underline">
                      {job.batchId.slice(0, 8)}
                    </Link>
                  </dd>
                </>
              )}
              {job.note && (
                <>
                  <dt className="text-slate-500">Preparer note</dt>
                  <dd>{job.note}</dd>
                </>
              )}
            </dl>
          </Card>
          <Card title="Files">
            <ul className="space-y-1 text-sm">
              {job.files.map((f) => (
                <li key={f.id} className="flex justify-between">
                  <span>
                    {f.kind}
                    {f.seq ? ` #${f.seq}` : ""}
                    {f.purgedAt && <span className="ml-1 text-xs text-slate-400">purged</span>}
                  </span>
                  <span className="text-slate-500">{fmtBytes(f.size)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
