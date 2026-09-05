import type { JobDetailDto, VerificationItemDto, VerificationResponse } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { Alert, Badge, Card, Spinner } from "../ui";

const KIND_LABEL: Record<string, string> = {
  amount: "Amount",
  percent: "Percentage",
  yoy: "Year-over-year",
  tax_year: "Tax year",
  filing_status: "Filing status",
  names: "Names",
  direction: "Refund vs. balance due",
  state: "State",
  deduction_type: "Deduction type",
  absence: "No PII",
  coverage: "Coverage",
};

function ItemRow({ item, jobId }: { item: VerificationItemDto; jobId: string }) {
  const ok = item.status === "verified";
  const href = item.page ? `/api/jobs/${jobId}/source.pdf#page=${item.page}&search=${encodeURIComponent(item.text.replace(/^\$/, ""))}` : null;
  return (
    <li className="flex items-start gap-2 border-t border-slate-100 py-1 text-sm">
      <span className={ok ? "text-emerald-700" : "text-red-700"} aria-label={ok ? "verified" : "flagged"}>
        {ok ? "✓" : "✗"}
      </span>
      <span className="w-36 shrink-0 text-xs uppercase tracking-wide text-slate-500">{KIND_LABEL[item.kind] ?? item.kind}</span>
      <span className="font-mono text-xs">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="text-brand hover:underline" title={`Open the return at page ${item.page}`}>
            {item.text}
          </a>
        ) : (
          item.text
        )}
      </span>
      <span className="text-xs text-slate-500">
        {ok ? (
          <>
            {item.page ? `p.${item.page} ` : ""}
            {item.label ?? ""}
          </>
        ) : (
          <span className="text-red-700">{item.reason}</span>
        )}
      </span>
      {item.slide && <span className="ml-auto text-xs text-slate-400">{item.slide}</span>}
    </li>
  );
}

export function VerificationPanel({ job }: { job: JobDetailDto }) {
  const { data, loading, error } = useApi<VerificationResponse>(`/api/jobs/${job.id}/verification`, 5000);
  const v = data?.verification ?? null;
  const flagged = v?.items.filter((i) => i.status === "flagged") ?? [];
  return (
    <Card
      title="Verification"
      actions={
        v ? (
          data?.stale ? (
            <Badge tone="amber">stale: script changed since this check</Badge>
          ) : v.passed ? (
            <Badge tone="green">all {v.items.length} items verified</Badge>
          ) : (
            <Badge tone="red">{flagged.length} flagged</Badge>
          )
        ) : undefined
      }
    >
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert kind="error">{error}</Alert>
      ) : !v ? (
        <p className="text-sm text-slate-500">Not verified yet. Every amount and fact in the script is traced to a page and line of the uploaded return before any audio is made.</p>
      ) : (
        <>
          {job.reconExceptionCount ? (
            <div className="mb-2">
              <Alert kind="warning">This job carries {job.reconExceptionCount} reconciliation exception(s) downgraded by a preparer. See the extraction panel.</Alert>
            </div>
          ) : null}
          <ul>
            {v.items.map((item, i) => (
              <ItemRow key={`${item.kind}-${item.text}-${i}`} item={item} jobId={job.id} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">Click an amount to open the return at the page where it was found. Approve stays disabled while anything is flagged.</p>
        </>
      )}
    </Card>
  );
}
