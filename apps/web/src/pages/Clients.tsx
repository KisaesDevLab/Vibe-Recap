import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import type { ClientDto, JobSummaryDto } from "@vibe-recap/shared";
import { useApi } from "../lib/useApi";
import { ApiError, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { JobTable } from "../components/JobTable";
import { Alert, Badge, Button, Card, Field, Input, PageTitle, Spinner, Textarea } from "../ui";

export function ClientsPage() {
  const [q, setQ] = useState("");
  const { data, loading, error, reload } = useApi<{ clients: ClientDto[] }>(`/api/clients?q=${encodeURIComponent(q)}`);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await post("/api/clients", { name });
      setName("");
      await reload();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Could not create client");
    }
  }

  return (
    <>
      <PageTitle>Clients</PageTitle>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <Card>
            <Input placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
            {loading && !data ? (
              <Spinner />
            ) : error ? (
              <Alert kind="error">{error}</Alert>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Jobs</th>
                    <th className="py-2 pr-3">Flags</th>
                    <th className="py-2 pr-3">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.clients.map((c) => (
                    <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="py-2 pr-3">
                        <Link to={`/clients/${c.id}`} className="text-brand hover:underline">
                          {c.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">{c.jobCount ?? 0}</td>
                      <td className="py-2 pr-3">{c.legalHold && <Badge tone="red">legal hold</Badge>}</td>
                      <td className="py-2 pr-3 text-slate-500">{fmtDate(c.createdAt)}</td>
                    </tr>
                  ))}
                  {data?.clients.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-4 text-slate-500">
                        No clients yet. They are created automatically when you queue an upload.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </Card>
        </div>
        <Card title="Add client">
          <form onSubmit={create} className="space-y-3">
            {msg && <Alert kind="error">{msg}</Alert>}
            <Field label="Name" hint="Last, First (matches how returns are detected)">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Button type="submit">Add</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<{ client: ClientDto; jobs: JobSummaryDto[] }>(id ? `/api/clients/${id}` : null);
  const [msg, setMsg] = useState<string | null>(null);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Client not found"}</Alert>;
  const c = data.client;

  async function save(p: Record<string, unknown>) {
    setMsg(null);
    try {
      await patch(`/api/clients/${id}`, p);
      await reload();
      setMsg("Saved");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Save failed");
    }
  }

  return (
    <>
      <PageTitle>{c.name}</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg === "Saved" ? "success" : "error"}>{msg}</Alert>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <Card title="Returns">
            <JobTable jobs={data.jobs} showClient={false} empty="No returns uploaded for this client." />
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Details">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                void save({ name: fd.get("name"), externalRef: fd.get("externalRef") || null, notes: fd.get("notes") || null });
              }}
            >
              <Field label="Name">
                <Input name="name" defaultValue={c.name} disabled={!can("preparer")} />
              </Field>
              <Field label="External reference" hint="Practice-management id, optional">
                <Input name="externalRef" defaultValue={c.externalRef ?? ""} disabled={!can("preparer")} />
              </Field>
              <Field label="Notes">
                <Textarea name="notes" rows={3} defaultValue={c.notes ?? ""} disabled={!can("preparer")} />
              </Field>
              {can("preparer") && <Button type="submit">Save</Button>}
            </form>
          </Card>
          <Card title="Retention">
            <p className="mb-3 text-xs text-slate-500">Blank uses the firm default. Legal hold suspends every purge for this client.</p>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const num = (k: string) => (fd.get(k) === "" ? null : Number(fd.get(k)));
                void save({
                  retentionSourceDays: num("retentionSourceDays"),
                  retentionExtractionDays: num("retentionExtractionDays"),
                  retentionVideoDays: num("retentionVideoDays"),
                });
              }}
            >
              <Field label="Source PDF days">
                <Input name="retentionSourceDays" type="number" min={0} defaultValue={c.retentionSourceDays ?? ""} disabled={!can("admin")} />
              </Field>
              <Field label="Extraction + script days">
                <Input name="retentionExtractionDays" type="number" min={0} defaultValue={c.retentionExtractionDays ?? ""} disabled={!can("admin")} />
              </Field>
              <Field label="Video days">
                <Input name="retentionVideoDays" type="number" min={0} defaultValue={c.retentionVideoDays ?? ""} disabled={!can("admin")} />
              </Field>
              {can("admin") && (
                <div className="flex items-center gap-2">
                  <Button type="submit">Save</Button>
                  <Button type="button" variant={c.legalHold ? "danger" : "secondary"} onClick={() => save({ legalHold: !c.legalHold })}>
                    {c.legalHold ? "Release legal hold" : "Place legal hold"}
                  </Button>
                </div>
              )}
              {c.legalHold && <Badge tone="red">legal hold active</Badge>}
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
