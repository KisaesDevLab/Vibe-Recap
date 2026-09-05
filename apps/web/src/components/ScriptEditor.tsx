import { useEffect, useMemo, useState } from "react";
import type { ExtractionDto, JobDetailDto, ScriptResponse } from "@vibe-recap/shared";
import { MAX_WORDS, MIN_WORDS, SLIDE_ORDER, slideSections, validateScript, wordCount } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, post, put } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Alert, Badge, Button, Card, Spinner, Textarea } from "../ui";

const EDITABLE = new Set(["needs_review", "failed", "rejected", "approved"]);

export function ScriptEditor({ job, extraction, onChanged }: { job: JobDetailDto; extraction: ExtractionDto | null; onChanged: () => void }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<ScriptResponse>(`/api/jobs/${job.id}/script`);
  const [text, setText] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  useEffect(() => {
    if (data?.script !== undefined && !dirty) setText(data.script ?? "");
  }, [data?.script, dirty]);

  // reload the stored script when the job changes state (worker finished a pass)
  useEffect(() => {
    void reload();
  }, [job.status, job.updatedAt, reload]);

  const live = useMemo(() => (extraction ? validateScript(text, extraction) : null), [text, extraction]);
  const wc = wordCount(text);
  const sections = slideSections(text);
  const editable = can("preparer") && EDITABLE.has(job.status) && extraction !== null;

  async function save() {
    setBusy(true);
    setMsg(null);
    setServerErrors([]);
    try {
      await put(`/api/jobs/${job.id}/script`, { script: text });
      setDirty(false);
      setMsg({ kind: "success", text: "Saved. The worker is validating, verifying, and re-rendering." });
      onChanged();
    } catch (e) {
      if (e instanceof ApiError) {
        setMsg({ kind: "error", text: e.message });
        const details = e.body.details as { errors?: string[] } | undefined;
        setServerErrors(details?.errors ?? []);
      } else setMsg({ kind: "error", text: "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    setMsg(null);
    try {
      await post(`/api/jobs/${job.id}/regenerate`);
      setDirty(false);
      setMsg({ kind: "info", text: "Regenerating with the language model. This takes a minute or two on the reference box." });
      onChanged();
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof ApiError ? e.message : "Regenerate failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Script"
      actions={
        editable ? (
          <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={regenerate}>
              Regenerate
            </Button>
            <Button size="sm" disabled={busy || !dirty || (live !== null && !live.ok)} onClick={save}>
              Save and re-render
            </Button>
          </>
        ) : undefined
      }
    >
      {msg && (
        <div className="mb-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <Alert kind="error">{error}</Alert>
      ) : !data?.script && !text ? (
        <p className="text-sm text-slate-500">No script yet. It is generated after the extraction reconciles.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <Textarea
              rows={22}
              className="font-mono text-xs leading-5"
              value={text}
              readOnly={!editable}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
              }}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Badge tone={wc < MIN_WORDS || wc > MAX_WORDS ? "amber" : "green"}>
                {wc} words ({MIN_WORDS}-{MAX_WORDS})
              </Badge>
              {live && (live.ok ? <Badge tone="green">passes validator</Badge> : <Badge tone="red">{live.errors.length} validator issue(s)</Badge>)}
              {data?.sha256 && data.extractionSha256 && <span>script {data.sha256.slice(0, 8)} · extraction {data.extractionSha256.slice(0, 8)}</span>}
              {dirty && <span className="text-amber-700">unsaved changes</span>}
            </div>
            {live && !live.ok && (
              <ul className="mt-2 space-y-0.5 text-xs text-red-700">
                {live.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {serverErrors.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-red-700">
                {serverErrors.map((e) => (
                  <li key={e}>server: {e}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="lg:col-span-2">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Slides</h3>
            <ol className="space-y-2 text-xs">
              {SLIDE_ORDER.map((slide) => {
                const sec = sections.find((s) => s.slide === slide);
                return (
                  <li key={slide} className={`rounded-md border p-2 ${sec ? "border-slate-200 bg-slate-50" : "border-dashed border-red-300"}`}>
                    <div className="mb-1 font-semibold text-slate-700">{slide}</div>
                    <div className="text-slate-600">{sec?.text || <span className="text-red-600">missing</span>}</div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Every dollar figure and percentage must exist in the extracted return figures. Edits are validated here, then the worker validates again and verifies every fact against the uploaded PDF before any audio is produced.
      </p>
    </Card>
  );
}
