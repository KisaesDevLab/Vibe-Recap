import { useState } from "react";
import { FEEDBACK_REASONS, type FeedbackDto, type JobDetailDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { Alert, Badge, Button, Card, Spinner, Textarea } from "../ui";

const FEEDBACK_STATUSES = new Set(["needs_review", "approved", "released", "rejected", "failed"]);
const LABELS = Object.fromEntries(FEEDBACK_REASONS.map((r) => [r.code, r.label]));

/**
 * Thumbs up / thumbs down on a finished recap. A thumbs-down asks what went wrong and keeps the
 * job's files for 90 days so the failure can be studied (Settings › Quality).
 */
export function FeedbackPanel({ job, onChanged }: { job: JobDetailDto; onChanged: () => void }) {
  const { can, user } = useAuth();
  const { data, loading, error, reload } = useApi<{ feedback: FeedbackDto[] }>(`/api/jobs/${job.id}/feedback`, 15000);
  const [mode, setMode] = useState<"idle" | "down">("idle");
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const rows = data?.feedback ?? [];
  const mine = rows.find((r) => r.by === user?.email);
  const enabled = can("staff") && FEEDBACK_STATUSES.has(job.status);

  async function send(verdict: "up" | "down") {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/jobs/${job.id}/feedback`, { verdict, reasons: verdict === "down" ? reasons : [], note: verdict === "down" ? note : null });
      setMode("idle");
      setReasons([]);
      setNote("");
      await reload();
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Could not save feedback");
    } finally {
      setBusy(false);
    }
  }

  function toggle(code: string) {
    setReasons((r) => (r.includes(code) ? r.filter((c) => c !== code) : [...r, code]));
  }

  return (
    <Card title="Was this recap right?">
      {msg && (
        <div className="mb-3">
          <Alert kind="error">{msg}</Alert>
        </div>
      )}
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert kind="error">{error}</Alert>
      ) : (
        <>
          {enabled && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant={mine?.verdict === "up" ? "primary" : "secondary"} disabled={busy} onClick={() => send("up")} aria-label="Thumbs up">
                👍 Good
              </Button>
              <Button size="sm" variant={mine?.verdict === "down" ? "primary" : "secondary"} disabled={busy} onClick={() => setMode(mode === "down" ? "idle" : "down")} aria-label="Thumbs down">
                👎 Something was wrong
              </Button>
              {mine && (
                <span className="text-xs text-slate-500">
                  You said thumbs {mine.verdict} on {fmtDate(mine.updatedAt)}. Sending again replaces it.
                </span>
              )}
            </div>
          )}
          {mode === "down" && (
            <div className="mb-3 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-600">
                What went wrong? Pick everything that applies. The return, extraction, script, and video are kept for 90 days so the problem can be traced back to its cause.
              </p>
              <div className="grid gap-1 sm:grid-cols-2">
                {FEEDBACK_REASONS.map((r) => (
                  <label key={r.code} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={reasons.includes(r.code)} onChange={() => toggle(r.code)} />
                    {r.label}
                  </label>
                ))}
              </div>
              <Textarea rows={2} placeholder="Anything else that helps (optional unless you chose 'Something else')" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" disabled={busy || reasons.length === 0} onClick={() => send("down")}>
                Send thumbs-down
              </Button>
            </div>
          )}
          {rows.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.verdict === "up" ? "green" : "red"}>{r.verdict === "up" ? "thumbs up" : "thumbs down"}</Badge>
                  <span className="text-slate-500">{r.by}</span>
                  <span className="text-xs text-slate-400">{fmtDate(r.updatedAt)}</span>
                  {r.reasons.length > 0 && <span>{r.reasons.map((c) => LABELS[c] ?? c).join("; ")}</span>}
                  {r.note && <span className="text-slate-700">“{r.note}”</span>}
                  {r.verdict === "down" && r.holdUntil && !r.dismissedAt && <span className="text-xs text-amber-700">files held until {fmtDate(r.holdUntil)}</span>}
                  {r.dismissedAt && <span className="text-xs text-slate-400">dismissed by {r.dismissedBy}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">{enabled ? "No feedback yet." : "Available once the job has finished."}</p>
          )}
        </>
      )}
    </Card>
  );
}
