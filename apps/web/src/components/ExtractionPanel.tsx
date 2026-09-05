import { useState } from "react";
import type { ExtractionDto, ExtractionResponse, JobDetailDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtMoney, fmtPct } from "../lib/format";
import { Alert, Badge, Button, Card, Spinner, Textarea } from "../ui";

const SECTIONS: Array<{ title: string; rows: Array<[string, (e: ExtractionDto) => string]> }> = [
  {
    title: "Income",
    rows: [
      ["Wages", (e) => fmtMoney(e.income.wages)],
      ["Taxable interest", (e) => fmtMoney(e.income.interest)],
      ["Ordinary dividends", (e) => fmtMoney(e.income.dividends)],
      ["IRA distributions and pensions (taxable)", (e) => fmtMoney(e.income.ira_pensions)],
      ["Social security (taxable)", (e) => fmtMoney(e.income.social_security_taxable)],
      ["Capital gain or loss", (e) => fmtMoney(e.income.capital_gain)],
      ["Schedule 1 additional income", (e) => fmtMoney(e.income.schedule_1_total)],
      ["Total income", (e) => fmtMoney(e.income.total_income)],
    ],
  },
  {
    title: "Adjustments and deductions",
    rows: [
      ["Schedule 1 adjustments", (e) => fmtMoney(e.adjustments.schedule_1_adjustments)],
      ["Adjusted gross income", (e) => fmtMoney(e.adjustments.agi)],
      ["Deduction", (e) => `${fmtMoney(e.deductions.amount)} (${e.deductions.type})`],
      ["QBI deduction", (e) => fmtMoney(e.deductions.qbi)],
      ["Taxable income", (e) => fmtMoney(e.deductions.taxable_income)],
    ],
  },
  {
    title: "Tax",
    rows: [
      ["Tax", (e) => fmtMoney(e.tax.tax)],
      ["Schedule 2 additional tax", (e) => fmtMoney(e.tax.schedule_2_total)],
      ["Nonrefundable credits", (e) => fmtMoney(e.tax.nonrefundable_credits)],
      ["Other taxes", (e) => fmtMoney(e.tax.other_taxes)],
      ["Total tax", (e) => fmtMoney(e.tax.total_tax)],
      ["Effective rate (of taxable income)", (e) => fmtPct(e.tax.effective_rate)],
    ],
  },
  {
    title: "Payments and result",
    rows: [
      ["Withholding", (e) => fmtMoney(e.payments.withholding)],
      ["Estimated payments", (e) => fmtMoney(e.payments.estimates)],
      ["Refundable credits", (e) => fmtMoney(e.payments.refundable_credits)],
      ["Total payments", (e) => fmtMoney(e.payments.total_payments)],
      ["Refund", (e) => fmtMoney(e.result.refund)],
      ["Applied to next year", (e) => fmtMoney(e.result.applied_to_next_year)],
      ["Amount owed", (e) => fmtMoney(e.result.amount_owed)],
    ],
  },
];

function ExceptionForm({ jobId, checks, onDone }: { jobId: string; checks: string[]; onDone: () => void }) {
  const [check, setCheck] = useState(checks[0] ?? "");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/jobs/${jobId}/recon-exceptions`, { check, reason });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
      <p className="text-xs text-amber-900">
        Downgrade a failed check to a warning for this job only. The check still runs and its mismatch stays visible on the job and in the verification panel. Give a reason of at least 20 characters; it is recorded in the audit log.
      </p>
      {err && <Alert kind="error">{err}</Alert>}
      <select className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm" value={check} onChange={(e) => setCheck(e.target.value)}>
        {checks.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <Textarea rows={2} placeholder="Why this mismatch is acceptable for this return" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button size="sm" variant="danger" disabled={busy || reason.trim().length < 20} onClick={submit}>
        Downgrade and re-run recon
      </Button>
    </div>
  );
}

export function ExtractionPanel({ job, onChanged }: { job: JobDetailDto; onChanged: () => void }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<ExtractionResponse>(`/api/jobs/${job.id}/extraction`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showException, setShowException] = useState(false);

  async function reextract() {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/jobs/${job.id}/re-extract`);
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const canReextract = can("preparer") && !["queued", "processing", "released", "purged"].includes(job.status);
  const ex = data?.extraction ?? null;
  const failedChecks = ex?.recon.checks.filter((c) => !c.ok && !c.warning).map((c) => c.name) ?? [];

  return (
    <Card
      title="Extraction"
      actions={
        canReextract ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={reextract}>
            Re-extract
          </Button>
        ) : undefined
      }
    >
      {msg && <Alert kind="error">{msg}</Alert>}
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert kind="error">{error}</Alert>
      ) : !ex ? (
        <p className="text-sm text-slate-500">No extraction yet. It appears once the worker finishes the extract step.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Read-only. Values come from the return via profile <code>{ex.meta.profile}</code>. If a line is misread, fix the form profile and re-extract; values are never hand-edited.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge>{ex.meta.software}</Badge>
            <Badge>{ex.meta.form} {ex.meta.tax_year}</Badge>
            <Badge>{ex.meta.filing_status}</Badge>
            {ex.meta.state_returns.map((s) => (
              <Badge key={s} tone="blue">
                {s}
              </Badge>
            ))}
            {ex.prior_year.present && <Badge tone="green">prior year: {ex.prior_year.source ?? "yes"}</Badge>}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {SECTIONS.map((sec) => (
              <div key={sec.title}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{sec.title}</h3>
                <table className="w-full text-sm">
                  <tbody>
                    {sec.rows.map(([label, fn]) => (
                      <tr key={label} className="border-t border-slate-100">
                        <td className="py-1 pr-2 text-slate-600">{label}</td>
                        <td className="py-1 text-right font-mono tabular-nums">{fn(ex)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {ex.state.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">State returns</h3>
                <table className="w-full text-sm">
                  <tbody>
                    {ex.state.map((s) => (
                      <tr key={s.code} className="border-t border-slate-100">
                        <td className="py-1 pr-2 text-slate-600">{s.code}</td>
                        <td className="py-1 text-right font-mono tabular-nums">
                          tax {fmtMoney(s.tax)} · {s.refund ? `refund ${fmtMoney(s.refund)}` : `owed ${fmtMoney(s.amount_owed)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ex.prior_year.present && (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Prior year</h3>
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="border-t border-slate-100">
                      <td className="py-1 pr-2 text-slate-600">AGI</td>
                      <td className="py-1 text-right font-mono tabular-nums">{fmtMoney(ex.prior_year.agi)}</td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="py-1 pr-2 text-slate-600">Total tax</td>
                      <td className="py-1 text-right font-mono tabular-nums">{fmtMoney(ex.prior_year.total_tax)}</td>
                    </tr>
                    <tr className="border-t border-slate-100">
                      <td className="py-1 pr-2 text-slate-600">Result</td>
                      <td className="py-1 text-right font-mono tabular-nums">{ex.prior_year.refund ? `refund ${fmtMoney(ex.prior_year.refund)}` : `owed ${fmtMoney(ex.prior_year.amount_owed)}`}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Reconciliation {ex.recon.passed ? <Badge tone="green">passed</Badge> : <Badge tone="red">failed</Badge>}</h3>
            <ul className="space-y-1 text-sm">
              {ex.recon.checks.map((c) => {
                const exception = data?.reconExceptions.find((e) => e.check === c.name);
                return (
                  <li key={c.name} className="flex items-start gap-2">
                    <span className={c.ok ? "text-emerald-700" : c.warning ? "text-amber-700" : "text-red-700"}>{c.ok ? "✓" : c.warning ? "⚠" : "✗"}</span>
                    <span className="font-mono text-xs">{c.name}</span>
                    {!c.ok && (
                      <span className="text-xs text-slate-600">
                        expected {fmtMoney(c.expected)}, found {fmtMoney(c.actual)}
                      </span>
                    )}
                    {exception && (
                      <span className="text-xs text-amber-800" title={`${exception.by} ${exception.at}`}>
                        downgraded: {exception.reason}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {job.status === "failed" && job.errorStep === "recon" && failedChecks.length > 0 && can("preparer") && (
              <>
                {!showException && (
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => setShowException(true)}>
                    Downgrade a check to a warning
                  </Button>
                )}
                {showException && (
                  <ExceptionForm
                    jobId={job.id}
                    checks={failedChecks}
                    onDone={() => {
                      setShowException(false);
                      void reload();
                      onChanged();
                    }}
                  />
                )}
              </>
            )}
          </div>
          {ex.observations.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Observations (computed)</h3>
              <ul className="text-sm text-slate-700">
                {ex.observations.map((o) => (
                  <li key={o.id} className="font-mono text-xs">
                    {o.id}: delta {fmtMoney(o.delta)} {o.pct ? `(${fmtPct(o.pct)})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
