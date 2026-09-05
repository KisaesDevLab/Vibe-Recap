import { Link } from "react-router";
import type { DashboardDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { JobTable } from "../components/JobTable";
import { Alert, Button, Card, PageTitle, Spinner } from "../ui";

export function DashboardPage() {
  const { can } = useAuth();
  const { data, error, loading } = useApi<DashboardDto>("/api/dashboard", 5000);
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Could not load dashboard"}</Alert>;
  return (
    <>
      <PageTitle
        actions={
          can("staff") ? (
            <Link to="/upload">
              <Button size="sm">Upload returns</Button>
            </Link>
          ) : undefined
        }
      >
        Dashboard
      </PageTitle>
      {data.activeBatches.length > 0 && (
        <div className="mb-4 flex gap-3 overflow-x-auto pb-1">
          {data.activeBatches.map((b) => {
            const total = b.fileCount || 1;
            const done = (b.counts.needs_review ?? 0) + (b.counts.approved ?? 0) + (b.counts.released ?? 0) + (b.counts.failed ?? 0) + (b.counts.rejected ?? 0);
            return (
              <Link key={b.id} to={`/batches/${b.id}`} className="min-w-56 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-xs hover:border-brand">
                <div className="flex justify-between">
                  <span className="font-medium">Batch {b.id.slice(0, 8)}</span>
                  <span className="text-slate-500">
                    {done}/{b.fileCount}
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-100">
                  <div className="h-1.5 bg-brand" style={{ width: `${Math.round((done / total) * 100)}%` }} />
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {fmtDate(b.createdAt)}
                  {b.counts.failed ? ` · ${b.counts.failed} failed` : ""}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Processing (${data.processing.length})`}>
          <JobTable jobs={data.processing} empty="Nothing in the queue." />
          <p className="mt-2 text-xs text-slate-400">
            Queue: {data.queue.waiting} waiting, {data.queue.active} active
          </p>
        </Card>
        <Card title={`Needs review (${data.needsReview.length})`}>
          <JobTable jobs={data.needsReview} empty="Nothing waiting for review." />
        </Card>
        <div className="lg:col-span-2">
          <Card title="Recent">
            <JobTable jobs={data.recent} empty="Upload a return to get started." />
          </Card>
        </div>
      </div>
    </>
  );
}
