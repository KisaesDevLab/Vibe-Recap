import { useState } from "react";
import type { JobDetailDto, RevisionDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { Alert, Badge, Button, Card, Spinner, Textarea } from "../ui";

const REVISABLE = new Set(["needs_review", "rejected", "approved", "failed"]);

export function RevisionPanel({ job, onChanged }: { job: JobDetailDto; onChanged: () => void }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<{ revisions: RevisionDto[] }>(`/api/jobs/${job.id}/revisions`, 4000);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const revisions = data?.revisions ?? [];
  const pending = revisions.some((r) => r.status === "pending");
  const canAsk = can("preparer") && REVISABLE.has(job.status) && !pending;

  async function send() {
    if (message.trim().length < 3) return;
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/jobs/${job.id}/revisions`, { message });
      setMessage("");
      await reload();
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Ask for changes">
      <p className="mb-3 text-xs text-slate-500">
        Describe the change in plain English, for example "warmer tone, one sentence shorter in the deductions section, mention the estimated payments earlier". The script is rewritten with your instruction, then validated against the extracted figures, verified against the return, and re-rendered. If the rewrite fails those checks after three attempts, the previous script and video stay as they are.
      </p>
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
        <ol className="mb-3 space-y-2">
          {revisions.map((r) => (
            <li key={r.id} className="rounded-md border border-slate-200 bg-slate-50 p-2 text-sm">
              <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                <span>{r.requestedBy}</span>
                <span>{fmtDate(r.createdAt)}</span>
                {r.status === "pending" && <Badge tone="blue">working</Badge>}
                {r.status === "applied" && <Badge tone="green">applied in {r.attempts} attempt{r.attempts === 1 ? "" : "s"}</Badge>}
                {r.status === "rejected" && <Badge tone="red">rejected</Badge>}
              </div>
              <div className="whitespace-pre-wrap">{r.message}</div>
              {r.status === "rejected" && r.error && <div className="mt-1 text-xs text-red-700">{r.error}</div>}
            </li>
          ))}
          {revisions.length === 0 && <li className="text-sm text-slate-500">No revision requests yet.</li>}
        </ol>
      )}
      {can("preparer") && (
        <div className="space-y-2">
          <Textarea rows={3} placeholder={pending ? "A revision is in progress..." : "What should change?"} value={message} disabled={!canAsk || busy} onChange={(e) => setMessage(e.target.value)} />
          <Button size="sm" disabled={!canAsk || busy || message.trim().length < 3} onClick={send}>
            Request revision
          </Button>
          {!REVISABLE.has(job.status) && <span className="ml-2 text-xs text-slate-500">Available once the job is in review.</span>}
        </div>
      )}
    </Card>
  );
}
