import { useState } from "react";
import { useApi } from "../lib/useApi";
import { fmtDate } from "../lib/format";
import { Alert, Button, Card, Input, PageTitle, Spinner } from "../ui";

interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  meta: Record<string, unknown>;
}

interface AuditResponse {
  total: number;
  page: number;
  pageSize: number;
  events: AuditEvent[];
  retentionNote: string;
}

export function SettingsAuditPage() {
  const [filters, setFilters] = useState({ actor: "", action: "", clientId: "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: "50" });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, k === "from" || k === "to" ? new Date(v).toISOString() : v);
  const { data, loading, error } = useApi<AuditResponse>(`/api/audit?${qs.toString()}`);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageTitle
        actions={
          <a href={`/api/audit/export.csv?${qs.toString()}`} className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium hover:bg-slate-50">
            Export CSV
          </a>
        }
      >
        Audit log
      </PageTitle>
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-5">
          <Input placeholder="Actor (email)" value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} />
          <Input placeholder="Action prefix, e.g. job.approve" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} />
          <Input placeholder="Client id" value={filters.clientId} onChange={(e) => setFilters({ ...filters, clientId: e.target.value })} />
          <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </div>
        {loading && !data ? (
          <Spinner />
        ) : error || !data ? (
          <Alert kind="error">{error ?? "Could not load"}</Alert>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">When</th>
                    <th className="py-1 pr-2">Actor</th>
                    <th className="py-1 pr-2">Action</th>
                    <th className="py-1 pr-2">Target</th>
                    <th className="py-1 pr-2">IP</th>
                    <th className="py-1 pr-2">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.id} className="border-t border-slate-100 align-top">
                      <td className="py-1 pr-2 whitespace-nowrap text-slate-500">{fmtDate(e.at)}</td>
                      <td className="py-1 pr-2">{e.actor}</td>
                      <td className="py-1 pr-2 font-mono">{e.action}</td>
                      <td className="py-1 pr-2 font-mono">
                        {e.targetType ? `${e.targetType}:${(e.targetId ?? "").slice(0, 8)}` : ""}
                      </td>
                      <td className="py-1 pr-2 text-slate-500">{e.ip ?? ""}</td>
                      <td className="py-1 pr-2 font-mono text-slate-600">{Object.keys(e.meta).length ? JSON.stringify(e.meta) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
              <span>
                {data.total} events · page {data.page} of {pages}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">{data.retentionNote}</p>
          </>
        )}
      </Card>
    </>
  );
}
