import { useState } from "react";
import { useParams } from "react-router";
import type { BatchDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { fmtDate } from "../lib/format";
import { JobTable } from "../components/JobTable";
import { Alert, Button, Card, PageTitle, Spinner } from "../ui";

export function BatchPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<BatchDto>(id ? `/api/batches/${id}` : null, 4000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Batch not found"}</Alert>;

  const jobs = data.jobs ?? [];
  const total = jobs.length || data.fileCount;
  const done = jobs.filter((j) => ["needs_review", "approved", "released", "purged", "failed", "rejected"].includes(j.status)).length;
  const failed = jobs.filter((j) => j.status === "failed");
  const pct = total ? Math.round((done / total) * 100) : 0;

  async function retryAll() {
    setBusy(true);
    setMsg(null);
    try {
      for (const j of failed) await post(`/api/jobs/${j.id}/retry`);
      setMsg(`Retried ${failed.length} job(s)`);
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle
        actions={
          failed.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={retryAll} disabled={busy}>
              Retry {failed.length} failed
            </Button>
          ) : undefined
        }
      >
        Batch {data.id.slice(0, 8)}
      </PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind="info">{msg}</Alert>
        </div>
      )}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Uploaded</div>
            <div>
              {fmtDate(data.createdAt)} by {data.uploadedBy}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Progress</div>
            <div>
              {done} of {total} finished
            </div>
          </div>
          {Object.entries(data.counts).map(([k, v]) => (
            <div key={k}>
              <div className="text-xs uppercase tracking-wide text-slate-500">{k.replace("_", " ")}</div>
              <div>{v}</div>
            </div>
          ))}
          {data.note && (
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Note</div>
              <div>{data.note}</div>
            </div>
          )}
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded bg-slate-100">
          <div className="h-2 bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
      </Card>
      <Card title="Jobs">
        <JobTable jobs={jobs} />
      </Card>
    </>
  );
}
