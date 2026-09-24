import { useState } from "react";
import {
  OVERRIDE_FIELDS,
  OVERRIDE_STATE_FIELDS,
  overridePathLabel,
  type AppliedOverrideDto,
  type ExtractionDto,
  type ExtractionOverrideDto,
} from "@vibe-recap/shared";
import { ApiError, del, post } from "../lib/api";
import { fmtDate, fmtMoney } from "../lib/format";
import { Alert, Button, Input, Select, Textarea } from "../ui";

/** "$1,234", "(3,000)", "-3000" or "1234-" -> integer dollars; null when it is not a whole-dollar amount. */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/[$,\s]/g, "");
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-") || t.endsWith("-");
  const digits = t.replace(/^\(|\)$/g, "").replace(/^-|-$/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(digits)) return null;
  const v = Math.round(Number(digits));
  return neg ? -v : v;
}

/** Every path the preparer may override on this extraction, grouped for the picker. */
function fieldOptions(ex: ExtractionDto | null): Array<{ group: string; path: string; label: string }> {
  const out: Array<{ group: string; path: string; label: string }> = OVERRIDE_FIELDS.map((f) => ({
    group: f.path.startsWith("prior_year") ? "Prior year" : "Federal",
    path: f.path,
    label: overridePathLabel(f.path),
  }));
  const codes = ex ? [...new Set([...ex.meta.state_returns, ...ex.state.map((s) => s.code)])] : [];
  for (const code of codes) {
    for (const f of OVERRIDE_STATE_FIELDS) out.push({ group: `${code} state return`, path: `state.${code}.${f.field}`, label: overridePathLabel(`state.${code}.${f.field}`) });
  }
  return out;
}

export function figureAt(ex: ExtractionDto | null, path: string): number | null {
  if (!ex) return null;
  const [section, key, field] = path.split(".");
  const v =
    section === "state"
      ? (ex.state.find((s) => s.code === key) as unknown as Record<string, unknown> | undefined)?.[field!]
      : (ex as unknown as Record<string, Record<string, unknown> | undefined>)[section!]?.[key!];
  return typeof v === "number" ? v : null;
}

interface Row {
  path: string;
  value: string;
}

/**
 * Enter figures from the return that the profile misread (Q66). One reason covers the batch; the
 * job re-runs from extract with the overrides applied, then recon, script, validate and verify.
 */
export function OverrideForm({ jobId, ex, onDone, onCancel }: { jobId: string; ex: ExtractionDto | null; onDone: () => void; onCancel: () => void }) {
  const options = fieldOptions(ex);
  const [rows, setRows] = useState<Row[]>([{ path: options[0]?.path ?? "", value: "" }]);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(options.map((o) => o.group))];
  const parsed = rows.map((r) => parseMoney(r.value));
  const paths = rows.map((r) => r.path);
  const duplicate = paths.some((p, i) => paths.indexOf(p) !== i);
  const ready = rows.length > 0 && parsed.every((v) => v !== null) && !duplicate && reason.trim().length >= 20;

  function update(i: number, patch: Partial<Row>) {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/jobs/${jobId}/extraction-overrides`, { overrides: rows.map((r, i) => ({ path: r.path, value: parsed[i] })), reason });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3">
      <p className="text-xs text-amber-900">
        Enter the figure exactly as the return shows it. Recon re-runs on the corrected figures, and the verifier still checks every amount in the script against the PDF, so a mistyped
        figure stops the job instead of reaching the video. Each override is logged with the line the profile misread, so the profile can be fixed.
      </p>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="space-y-2">
        {rows.map((r, i) => {
          const current = figureAt(ex, r.path);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select className="min-w-0 flex-1" value={r.path} onChange={(e) => update(i, { path: e.target.value })} aria-label="Figure">
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {options
                      .filter((o) => o.group === g)
                      .map((o) => (
                        <option key={o.path} value={o.path}>
                          {o.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
              <span className="w-28 text-right font-mono text-xs text-slate-500" title="The figure the extraction holds now">
                {current === null ? "not read" : fmtMoney(current)}
              </span>
              <span className="text-slate-400">→</span>
              <Input
                className="w-32 font-mono"
                inputMode="decimal"
                placeholder="$0"
                value={r.value}
                onChange={(e) => update(i, { value: e.target.value })}
                aria-label="Figure from the return"
                aria-invalid={r.value !== "" && parsed[i] === null}
              />
              {rows.length > 1 && (
                <Button size="sm" variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove this figure">
                  ✕
                </Button>
              )}
            </div>
          );
        })}
        {duplicate && <p className="text-xs text-red-700">Each figure can appear once.</p>}
        <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { path: options.find((o) => !paths.includes(o.path))?.path ?? "", value: "" }])}>
          Add another figure
        </Button>
      </div>
      <Textarea rows={2} placeholder="What the profile misread and where on the return you read the figure (at least 20 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant="danger" disabled={busy || !ready} onClick={submit}>
          Override and re-run
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The job's active overrides, each with the figure the profile read and a Remove button. */
export function OverrideList({
  jobId,
  overrides,
  applied,
  canEdit,
  onChanged,
}: {
  jobId: string;
  overrides: ExtractionOverrideDto[];
  applied: AppliedOverrideDto[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (overrides.length === 0) return null;

  async function remove(id: string) {
    setBusy(id);
    setErr(null);
    try {
      await del(`/api/jobs/${jobId}/extraction-overrides/${id}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Overridden figures</h3>
      {err && <Alert kind="error">{err}</Alert>}
      <ul className="space-y-2 text-sm">
        {overrides.map((o) => {
          const rec = applied.find((a) => a.id === o.id);
          return (
            <li key={o.id} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium text-slate-800">{overridePathLabel(o.path)}</span>
                <span className="font-mono text-xs text-slate-600">
                  read {o.extractedValue === null ? "nothing" : fmtMoney(o.extractedValue)} → {fmtMoney(o.value)}
                </span>
                {canEdit && (
                  <Button size="sm" variant="secondary" className="ml-auto" disabled={busy !== null} onClick={() => void remove(o.id)}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-600">{o.reason}</p>
              <p className="text-xs text-slate-400">
                {o.by} · {fmtDate(o.at)}
              </p>
              {rec?.matches_extracted && (
                <p className="mt-1 text-xs text-emerald-800">The extraction now reads this figure itself; the override can be removed.</p>
              )}
              {!rec && <p className="mt-1 text-xs text-slate-500">Applied on the next extraction run.</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
