import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import type { ClientDto, StageDto, StagedFileDto, StagedFilePatch } from "@vibe-recap/shared";
import { ApiError, api, get, patch, post } from "../lib/api";
import { fmtBytes } from "../lib/format";
import { Alert, Badge, Button, Card, Input, PageTitle, Select, Spinner } from "../ui";

function ClientPicker({ file, clients, onChange }: { file: StagedFileDto; clients: ClientDto[]; onChange: (p: StagedFilePatch) => void }) {
  const [mode, setMode] = useState<"existing" | "new">(file.clientId ? "existing" : "new");
  useEffect(() => {
    setMode(file.clientId ? "existing" : "new");
  }, [file.clientId]);
  return (
    <div className="space-y-1">
      {file.match?.type === "suggested" && !file.clientId && (
        <button
          type="button"
          className="text-xs text-brand hover:underline"
          onClick={() => onChange({ clientId: file.match!.clientId! })}
        >
          Use suggested: {file.match.clientName} ({Math.round((file.match.score ?? 0) * 100)}%)
        </button>
      )}
      <div className="flex gap-1">
        <Select
          value={mode === "existing" ? (file.clientId ?? "") : "__new__"}
          onChange={(e) => {
            if (e.target.value === "__new__") {
              setMode("new");
              onChange({ clientId: null, newClientName: file.newClientName ?? file.match?.clientName ?? "" });
            } else {
              setMode("existing");
              onChange({ clientId: e.target.value });
            }
          }}
          className="min-w-48"
        >
          <option value="__new__">New client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      {mode === "new" && (
        <Input
          placeholder="Last, First"
          defaultValue={file.newClientName ?? ""}
          onBlur={(e) => onChange({ newClientName: e.target.value })}
        />
      )}
    </div>
  );
}

export function UploadPage() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<StageDto | null>(null);
  const [clients, setClients] = useState<ClientDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [batchNote, setBatchNote] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    get<{ clients: ClientDto[] }>("/api/clients").then((r) => setClients(r.clients)).catch(() => {});
  }, [stage?.id]);

  const upload = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of list) fd.append("files", f, f.name);
      const dto = await api<StageDto>("POST", "/api/uploads/stage", fd);
      setStage(dto);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }, []);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files);
  }

  async function update(fileId: string, p: StagedFilePatch) {
    if (!stage) return;
    try {
      setStage(await patch<StageDto>(`/api/uploads/stage/${stage.id}/files/${fileId}`, p));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
    }
  }

  async function queue() {
    if (!stage) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ batchId: string }>(`/api/uploads/stage/${stage.id}/queue`, { note: batchNote || undefined });
      navigate(`/batches/${r.batchId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Queue failed");
    } finally {
      setBusy(false);
    }
  }

  const sources = stage?.files.filter((f) => f.role === "source") ?? [];
  const priors = stage?.files.filter((f) => f.role === "prior") ?? [];
  const queueable = sources.filter((f) => f.include && f.status === "ok");
  const blocked = queueable.filter((f) => !f.taxYear || (!f.clientId && !f.newClientName));

  return (
    <>
      <PageTitle>Upload returns</PageTitle>
      {error && (
        <div className="mb-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}
      {!stage && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-12 text-center ${dragging ? "border-brand bg-sky-50" : "border-slate-300 bg-white"}`}
        >
          {busy ? (
            <Spinner label="Reading returns…" />
          ) : (
            <>
              <p className="text-base font-medium text-slate-800">Drop completed return PDFs here</p>
              <p className="mt-1 text-sm text-slate-500">One or many PDFs, or a ZIP of PDFs. Up to 200 files, 100 MB each. Include last year's return to get year-over-year observations.</p>
              <Button className="mt-4" onClick={() => inputRef.current?.click()}>
                Choose files
              </Button>
              <input ref={inputRef} type="file" multiple accept=".pdf,.zip,application/pdf,application/zip" className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
            </>
          )}
        </div>
      )}
      {stage && (
        <div className="space-y-4">
          <Card
            title={`${sources.length} return${sources.length === 1 ? "" : "s"} staged`}
            actions={
              <>
                <Button variant="secondary" size="sm" onClick={() => setStage(null)} disabled={busy}>
                  Start over
                </Button>
                <Button size="sm" onClick={queue} disabled={busy || queueable.length === 0 || blocked.length > 0}>
                  Queue {queueable.length} job{queueable.length === 1 ? "" : "s"}
                </Button>
              </>
            }
          >
            <p className="mb-3 text-xs text-slate-500">
              Confirm the client for each return. Rows without a confident match need a client before queueing. Staged files expire in one hour if not queued.
            </p>
            {blocked.length > 0 && (
              <div className="mb-3">
                <Alert kind="warning">{blocked.length} selected row(s) still need a client or tax year.</Alert>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-2">Queue</th>
                    <th className="py-2 pr-2">File</th>
                    <th className="py-2 pr-2">Detected</th>
                    <th className="py-2 pr-2">Client</th>
                    <th className="py-2 pr-2">Year</th>
                    <th className="py-2 pr-2">Prior-year PDF</th>
                    <th className="py-2 pr-2">Notes for the script</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((f) => (
                    <tr key={f.fileId} className={`border-t border-slate-100 align-top ${f.status === "skipped" ? "bg-slate-50 text-slate-400" : ""}`}>
                      <td className="py-2 pr-2">
                        <input type="checkbox" checked={f.include} disabled={f.status !== "ok"} onChange={(e) => update(f.fileId, { include: e.target.checked })} />
                      </td>
                      <td className="max-w-56 py-2 pr-2">
                        <div className="truncate" title={f.originalName}>
                          {f.originalName}
                        </div>
                        <div className="text-xs text-slate-400">{f.size ? fmtBytes(f.size) : ""}</div>
                        {f.status === "skipped" && <Badge tone="red">{f.skipReason}</Badge>}
                        {f.warnings.map((w) => (
                          <div key={w} className="mt-1 text-xs text-amber-700">
                            {w}
                          </div>
                        ))}
                      </td>
                      <td className="py-2 pr-2 text-xs text-slate-600">
                        {f.detected && (
                          <>
                            <div>
                              {f.detected.lastName}, {f.detected.firstName}
                              {f.detected.spouseFirstName ? ` & ${f.detected.spouseFirstName}` : ""}
                            </div>
                            <div className="text-slate-400">
                              {f.detected.software} · {f.detected.form} · {f.detected.pageCount} pages
                            </div>
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {f.status === "ok" && (
                          <>
                            {f.match?.type === "exact" && f.clientId && <Badge tone="green">matched</Badge>}
                            <ClientPicker file={f} clients={clients} onChange={(p) => update(f.fileId, p)} />
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {f.status === "ok" && (
                          <Input
                            type="number"
                            className="w-24"
                            defaultValue={f.taxYear ?? ""}
                            onBlur={(e) => update(f.fileId, { taxYear: e.target.value ? Number(e.target.value) : null })}
                          />
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {f.status === "ok" && (
                          <Select value={f.priorFileId ?? ""} onChange={(e) => update(f.fileId, { priorFileId: e.target.value || null })} className="min-w-40">
                            <option value="">None</option>
                            {stage.files
                              .filter((p) => p.status === "ok" && p.fileId !== f.fileId && (p.role === "prior" || !p.priorFileId))
                              .map((p) => (
                                <option key={p.fileId} value={p.fileId}>
                                  {p.originalName} ({p.taxYear ?? "?"})
                                </option>
                              ))}
                          </Select>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {f.status === "ok" && (
                          <Input placeholder="e.g. mention the new rental" defaultValue={f.note ?? ""} onBlur={(e) => update(f.fileId, { note: e.target.value })} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {priors.length > 0 && (
              <p className="mt-3 text-xs text-slate-500">
                {priors.length} file(s) paired as prior-year returns: {priors.map((p) => p.originalName).join(", ")}
              </p>
            )}
            <div className="mt-4 max-w-md">
              <Input placeholder="Batch note (optional)" value={batchNote} onChange={(e) => setBatchNote(e.target.value)} />
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
