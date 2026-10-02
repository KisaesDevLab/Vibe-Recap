import { useEffect, useState } from "react";
import type { AiAttemptDto, AiExchangeRunDto, AiExchangesResponse, JobDetailDto } from "@vibe-recap/shared";
import { ApiError, get } from "../lib/api";
import { useApi } from "../lib/useApi";
import { fmtDate } from "../lib/format";
import { Alert, Badge, Button, Card, Spinner, Textarea } from "../ui";

/** The conversation exactly as the worker sent it, one block per message. */
function transcript(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `── ${m.role} ──\n${m.content}`).join("\n\n");
}

function tokens(a: AiAttemptDto): string {
  if (a.promptTokens === null && a.completionTokens === null) return "";
  return `${a.promptTokens ?? "?"} → ${a.completionTokens ?? "?"}`;
}

function ExchangeDialog({ jobId, fileId, attempt, onClose }: { jobId: string; fileId: string; attempt: number; onClose: () => void }) {
  const [run, setRun] = useState<AiExchangeRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    get<AiExchangeRunDto>(`/api/jobs/${jobId}/ai-exchanges/${fileId}`)
      .then((r) => alive && setRun(r))
      .catch((err: unknown) => alive && setError(err instanceof ApiError ? err.message : "Could not load"));
    return () => {
      alive = false;
    };
  }, [jobId, fileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const a = run?.attempts.find((x) => x.attempt === attempt) ?? null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`AI exchange, run ${run?.seq ?? ""} attempt ${attempt}`}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">
            {run ? `Run #${run.seq} (${run.run}) · attempt ${attempt}` : "AI exchange"}
          </h2>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className="space-y-3 overflow-y-auto p-4">
          {error && <Alert kind="error">{error}</Alert>}
          {!run && !error && <Spinner />}
          {run && !a && <Alert kind="error">Attempt {attempt} is not in this run.</Alert>}
          {run && a && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <dt className="text-slate-500">Provider</dt>
                <dd>{run.provider}</dd>
                <dt className="text-slate-500">Model</dt>
                <dd className="font-mono">{a.model ?? ""}</dd>
                <dt className="text-slate-500">Tokens in → out</dt>
                <dd>{tokens(a)}</dd>
                <dt className="text-slate-500">Finish</dt>
                <dd className={a.finishReason === "length" ? "font-medium text-red-700" : ""}>{a.finishReason ?? ""}</dd>
                <dt className="text-slate-500">Words</dt>
                <dd>{a.words}</dd>
                <dt className="text-slate-500">Time</dt>
                <dd>{a.ms !== null ? `${(a.ms / 1000).toFixed(1)} s` : ""}</dd>
              </dl>
              {a.errors.length > 0 && (
                <Alert kind="error">
                  <ul className="list-disc pl-4 text-xs">
                    {a.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              <div>
                <div className="mb-1 text-xs font-medium text-slate-600">Sent to the AI ({a.request?.length ?? 0} messages)</div>
                <Textarea readOnly rows={14} className="font-mono text-xs" value={transcript(a.request ?? [])} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-slate-600">Returned</div>
                <Textarea readOnly rows={10} className="font-mono text-xs" value={a.response ?? ""} />
              </div>
              <p className="text-xs text-slate-500">
                This is what Recap sent. When the provider is the AI Router, the router may redact protected data before a cloud model sees it. Opening
                this view is recorded in the audit log.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Job page: every captured script-step run, one row per model call; a row opens the full exchange. */
export function AiExchangesPanel({ job }: { job: JobDetailDto }) {
  const { data, loading, error } = useApi<AiExchangesResponse>(`/api/jobs/${job.id}/ai-exchanges`, 10000);
  const [open, setOpen] = useState<{ fileId: string; attempt: number } | null>(null);
  const runs = data?.runs ?? [];

  if (!data && loading) return null;
  if (data && !data.enabled && runs.length === 0) return null; // feature off and nothing recorded: no panel

  return (
    <Card title="AI exchanges" actions={data && !data.enabled ? <Badge tone="amber">capture off</Badge> : undefined}>
      {error && <Alert kind="error">{error}</Alert>}
      {runs.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing recorded yet. The next script generation or revision for this job will appear here.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 pr-3">Run</th>
                <th className="py-1 pr-3">Attempt</th>
                <th className="py-1 pr-3">Model</th>
                <th className="py-1 pr-3">Tokens in → out</th>
                <th className="py-1 pr-3">Finish</th>
                <th className="py-1 pr-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.flatMap((r) =>
                r.purged
                  ? [
                      <tr key={r.fileId} className="border-t border-slate-100 text-slate-400">
                        <td className="py-1 pr-3">#{r.seq}</td>
                        <td colSpan={5} className="py-1 pr-3">
                          purged by retention
                        </td>
                      </tr>,
                    ]
                  : r.attempts.map((a) => (
                      <tr
                        key={`${r.fileId}-${a.attempt}`}
                        className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                        onClick={() => setOpen({ fileId: r.fileId, attempt: a.attempt })}
                        title="Show what was sent and returned"
                      >
                        <td className="py-1 pr-3 whitespace-nowrap">
                          #{r.seq} {r.run}
                          <div className="text-xs text-slate-400">{fmtDate(a.at ?? r.at)}</div>
                        </td>
                        <td className="py-1 pr-3">{a.attempt}</td>
                        <td className="py-1 pr-3 font-mono text-xs">{a.model ?? ""}</td>
                        <td className="py-1 pr-3 text-xs">{tokens(a)}</td>
                        <td className={`py-1 pr-3 text-xs ${a.finishReason === "length" ? "font-medium text-red-700" : ""}`}>{a.finishReason ?? ""}</td>
                        <td className="py-1 pr-3 text-xs">
                          {a.ok ? (
                            <Badge tone="green">passed · {a.words} words</Badge>
                          ) : (
                            <span className="text-red-700" title={a.errors.join("\n")}>
                              rejected · {a.words} words
                            </span>
                          )}
                        </td>
                      </tr>
                    )),
              )}
            </tbody>
          </table>
        </div>
      )}
      {open && <ExchangeDialog jobId={job.id} fileId={open.fileId} attempt={open.attempt} onClose={() => setOpen(null)} />}
    </Card>
  );
}
