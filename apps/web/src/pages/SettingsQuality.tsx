import { useState } from "react";
import { Link } from "react-router";
import { FEEDBACK_REASONS, overridePathLabel, type ExtractionOverrideLogResponse, type FeedbackListDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { fmtDate, fmtMoney } from "../lib/format";
import { Alert, Badge, Button, Card, PageTitle, Spinner } from "../ui";
import { StatusBadge } from "../components/JobTable";

const LABELS = Object.fromEntries(FEEDBACK_REASONS.map((r) => [r.code, r.label]));

/**
 * Admin view of preparer feedback: thumbs up/down counts, the reasons behind thumbs-downs, and the
 * open cases whose files are on hold. Each case can be downloaded as a diagnostic bundle for
 * profile and prompt work, or dismissed to release the hold.
 */
export function SettingsQualityPage() {
  const [scope, setScope] = useState<"open" | "all">("open");
  const [days, setDays] = useState(90);
  const { data, loading, error, reload } = useApi<FeedbackListDto>(`/api/feedback?scope=${scope}&days=${days}`);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function dismiss(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      await post(`/api/feedback/${id}/dismiss`, {});
      await reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Could not dismiss");
    } finally {
      setBusy(null);
    }
  }

  const stats = data?.stats;
  const total = (stats?.up ?? 0) + (stats?.down ?? 0);
  const reasonRows = stats ? Object.entries(stats.byReason).sort((a, b) => b[1] - a[1]) : [];

  return (
    <>
      <PageTitle
        actions={
          <div className="flex items-center gap-2 text-sm">
            <select className="rounded-md border border-slate-300 px-2 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={30}>last 30 days</option>
              <option value={90}>last 90 days</option>
              <option value={365}>last year</option>
            </select>
            <select className="rounded-md border border-slate-300 px-2 py-1" value={scope} onChange={(e) => setScope(e.target.value as "open" | "all")}>
              <option value="open">open thumbs-downs</option>
              <option value="all">all feedback</option>
            </select>
          </div>
        }
      >
        Quality
      </PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind="error">{msg}</Alert>
        </div>
      )}
      {loading && !data ? (
        <Spinner />
      ) : error || !data || !stats ? (
        <Alert kind="error">{error ?? "Could not load"}</Alert>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Card title={`Verdicts, last ${stats.days} days`}>
              <div className="text-3xl font-semibold">{total ? `${Math.round((stats.up / total) * 100)}%` : "–"}</div>
              <div className="text-sm text-slate-500">
                thumbs up · {stats.up} up, {stats.down} down
              </div>
            </Card>
            <Card title="Files on hold">
              <div className="text-3xl font-semibold">{stats.openHolds}</div>
              <div className="text-sm text-slate-500">jobs kept past retention until reviewed (90 days, or dismiss below)</div>
            </Card>
            <Card title="Why thumbs-down">
              {reasonRows.length === 0 ? (
                <p className="text-sm text-slate-500">No thumbs-downs in this period.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {reasonRows.map(([code, n]) => (
                    <li key={code} className="flex justify-between gap-2">
                      <span>{LABELS[code] ?? code}</span>
                      <span className="font-mono">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <Card title={scope === "open" ? "Open cases" : "All feedback"}>
            <p className="mb-3 text-xs text-slate-500">
              A bundle holds the extraction, verification, script, pipeline events with every script attempt, and the return itself when it is still on disk. It is for fixing form profiles and prompts; treat it like the return. Dismissing releases the retention hold and keeps the feedback on record.
            </p>
            {data.rows.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing here.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-1 pr-2">When</th>
                      <th className="py-1 pr-2">Client</th>
                      <th className="py-1 pr-2">Job</th>
                      <th className="py-1 pr-2">Verdict</th>
                      <th className="py-1 pr-2">Reasons</th>
                      <th className="py-1 pr-2">By</th>
                      <th className="py-1 pr-2">Hold</th>
                      <th className="py-1 pr-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100 align-top">
                        <td className="py-1 pr-2 whitespace-nowrap text-slate-500">{fmtDate(r.updatedAt)}</td>
                        <td className="py-1 pr-2">
                          <Link to={`/clients/${r.clientId}`} className="hover:underline">
                            {r.clientName}
                          </Link>
                          <span className="ml-1 text-slate-400">{r.taxYear}</span>
                        </td>
                        <td className="py-1 pr-2">
                          <Link to={`/jobs/${r.jobId}`} className="font-mono text-xs text-brand hover:underline">
                            {r.jobId.slice(0, 8)}
                          </Link>
                          <div>
                            <StatusBadge status={r.jobStatus} />
                          </div>
                        </td>
                        <td className="py-1 pr-2">
                          <Badge tone={r.verdict === "up" ? "green" : "red"}>{r.verdict}</Badge>
                        </td>
                        <td className="py-1 pr-2">
                          {r.reasons.map((c) => LABELS[c] ?? c).join("; ")}
                          {r.note && <div className="text-xs text-slate-600">“{r.note}”</div>}
                        </td>
                        <td className="py-1 pr-2 text-slate-500">{r.by}</td>
                        <td className="py-1 pr-2 text-xs">
                          {r.dismissedAt ? (
                            <span className="text-slate-400">dismissed {fmtDate(r.dismissedAt)}</span>
                          ) : r.holdUntil ? (
                            <span className="text-amber-700">until {fmtDate(r.holdUntil)}</span>
                          ) : (
                            ""
                          )}
                          {r.filesPurged && <div className="text-red-700">source purged</div>}
                        </td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          <a href={`/api/feedback/${r.id}/bundle.zip`} className="mr-2 text-xs text-brand hover:underline">
                            Bundle
                          </a>
                          {r.verdict === "down" && !r.dismissedAt && (
                            <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => dismiss(r.id)}>
                              Dismiss
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
      <OverrideLogCard days={days} />
    </>
  );
}

/**
 * Every preparer override of an extracted figure in the period (Q66). Each one marks a line a form
 * profile misread; "read from" names the page, IRS line and label the profile used, and the counts
 * by field show which rules to fix first. The CSV carries the same rows for profile work.
 */
function OverrideLogCard({ days }: { days: number }) {
  const { data, loading, error } = useApi<ExtractionOverrideLogResponse>(`/api/extraction-overrides?days=${days}`);
  return (
    <Card
      className="mt-4"
      title="Overridden figures"
      actions={
        <a className="text-sm text-brand hover:underline" href={`/api/extraction-overrides?days=${days}&format=csv`}>
          Download CSV
        </a>
      }
    >
      <p className="mb-3 text-xs text-slate-500">
        A preparer overrode these figures because the form profile misread the line. Fix the profile rule named under “read from”, then the override on later returns reads
        “the extraction now reads this figure”. Amounts are cleared when a job is purged; the field, line and reason stay.
      </p>
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert kind="error">{error}</Alert>
      ) : !data || data.overrides.length === 0 ? (
        <p className="text-sm text-slate-500">No overrides in this period.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs">
            {data.byPath.map((b) => (
              <Badge key={b.path} tone="amber">
                {overridePathLabel(b.path)} × {b.count}
              </Badge>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1 pr-2">When</th>
                  <th className="py-1 pr-2">Figure</th>
                  <th className="py-1 pr-2">Read from</th>
                  <th className="py-1 pr-2 text-right">Read / corrected</th>
                  <th className="py-1 pr-2">Reason</th>
                  <th className="py-1">Job</th>
                </tr>
              </thead>
              <tbody>
                {data.overrides.map((o) => {
                  const ev = o.evidence?.[0];
                  return (
                    <tr key={o.id} className={o.removedAt ? "border-t border-slate-100 text-slate-400" : "border-t border-slate-100"}>
                      <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(o.at)}</td>
                      <td className="py-1 pr-2">
                        {overridePathLabel(o.path)}
                        <div className="text-xs text-slate-400">
                          {o.software} {o.taxYear} · {o.profile ?? "no profile"}
                        </div>
                      </td>
                      <td className="py-1 pr-2 text-xs">{ev ? `p${ev.page} line ${ev.line ?? "?"}: ${ev.label}` : "not found"}</td>
                      <td className="py-1 pr-2 text-right font-mono text-xs whitespace-nowrap">
                        {o.valuesPurged ? "purged" : `${o.extractedValue === null ? "none" : fmtMoney(o.extractedValue)} → ${fmtMoney(o.value)}`}
                      </td>
                      <td className="py-1 pr-2 text-xs">
                        {o.reason}
                        <div className="text-slate-400">
                          {o.by}
                          {o.removedAt ? ` · removed by ${o.removedBy}` : ""}
                        </div>
                      </td>
                      <td className="py-1 text-xs">
                        <Link className="text-brand hover:underline" to={`/jobs/${o.jobId}`}>
                          open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
