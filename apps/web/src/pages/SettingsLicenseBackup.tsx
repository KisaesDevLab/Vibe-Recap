import { useState, type FormEvent } from "react";
import { useApi } from "../lib/useApi";
import { ApiError, post, put } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Alert, Badge, Button, Card, Field, Input, PageTitle, Spinner } from "../ui";

interface LicenseState {
  status: "valid" | "grace" | "invalid" | "unlicensed";
  readOnly: boolean;
  keyMasked: string | null;
  seats: number | null;
  seatsInUse: number;
  validUntil: string | null;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  message: string | null;
}

const TONE: Record<LicenseState["status"], "green" | "amber" | "red" | "slate"> = { valid: "green", grace: "amber", invalid: "red", unlicensed: "slate" };

export function SettingsLicensePage() {
  const { data, loading, error, reload } = useApi<LicenseState>("/api/settings/license");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await reload();
      setMsg({ kind: "success", text: ok });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Could not load"}</Alert>;

  return (
    <>
      <PageTitle>License</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Status">
          <div className="space-y-2 text-sm">
            <div>
              <Badge tone={TONE[data.status]}>{data.status}</Badge> {data.readOnly && <Badge tone="red">read-only</Badge>}
            </div>
            {data.message && <p className="text-slate-600">{data.message}</p>}
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-slate-500">Key</dt>
              <dd className="font-mono">{data.keyMasked ?? "none"}</dd>
              <dt className="text-slate-500">Seats</dt>
              <dd>
                {data.seatsInUse} in use{data.seats !== null ? ` of ${data.seats}` : ""}
              </dd>
              <dt className="text-slate-500">Valid until</dt>
              <dd>{data.validUntil ? fmtDate(data.validUntil) : "-"}</dd>
              <dt className="text-slate-500">Last checked</dt>
              <dd>{data.lastCheckedAt ? fmtDate(data.lastCheckedAt) : "never"}</dd>
              <dt className="text-slate-500">Last valid</dt>
              <dd>{data.lastValidAt ? fmtDate(data.lastValidAt) : "never"}</dd>
            </dl>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => post("/api/settings/license/check"), "Checked with the licensing server.")}>
              Check now
            </Button>
            <p className="text-xs text-slate-500">Checked daily against licensing.kisaes.com, the only outbound connection this application makes. If the server is unreachable the license stays valid for 14 days.</p>
          </div>
        </Card>
        <Card title="License key">
          <form
            className="space-y-3"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const key = String(new FormData(e.currentTarget).get("key") || "");
              void run(() => put("/api/settings/license", { key }), "Key saved and validated.");
            }}
          >
            <Field label="Key">
              <Input name="key" placeholder="paste the key from your Kisaes order" required minLength={8} />
            </Field>
            <Button type="submit" disabled={busy}>
              Save and validate
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}

export function SettingsBackupPage() {
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"merge" | "replace">("merge");

  async function importFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { settings?: unknown; profiles?: unknown };
      const r = await post<{ settings: number; profiles: number }>("/api/settings/backup/import", { mode, settings: parsed.settings, profiles: parsed.profiles });
      setMsg({ kind: "success", text: `Imported ${r.settings} setting(s) and ${r.profiles} form profile(s) (${mode}).` });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Import failed: is this a settings export?" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle>Backup</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Settings and form profiles">
          <p className="mb-3 text-sm text-slate-600">Export the firm settings (branding, voice, model, retention windows) and the form profiles as one JSON file. No client data and no keys are included; the license key is excluded.</p>
          <a href="/api/settings/backup/export" className="inline-flex rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong">
            Export settings JSON
          </a>
          <div className="mt-4 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === "merge"} onChange={() => setMode("merge")} /> Merge: only keys present in the file change
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace: reset everything to the file (missing keys go back to defaults)
            </label>
            <input type="file" accept="application/json" disabled={busy} onChange={(e) => importFile(e.target.files?.[0] ?? null)} />
          </div>
        </Card>
        <Card title="Data backups (Duplicati)">
          <div className="space-y-2 text-sm text-slate-700">
            <p>
              Client files live under the <code>RECAP_DATA</code> directory (default <code>./data</code> next to <code>compose.yml</code>) and the Postgres volume. Back up both, together, on a schedule:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <code>data/blobs</code>: encrypted returns, scripts, and videos. Useless without <code>data/keys</code>.
              </li>
              <li>
                <code>data/keys/master.key</code>: the master key. Store this copy separately and offline. Losing it makes every blob unrecoverable.
              </li>
              <li>
                Postgres: <code>docker compose exec postgres pg_dump -U recap recap &gt; recap.sql</code> nightly, or back up the <code>pg_data</code> volume with the stack stopped.
              </li>
            </ul>
            <p>
              A Duplicati sidecar is pre-wired in <code>compose.override.example.yml</code>; uncomment it, start the stack, and open <code>http://&lt;host&gt;:8200</code> to point it at <code>/source/recap-data</code> and your destination. Duplicati encrypts again in transit, which is fine.
            </p>
            <p className="text-xs text-slate-500">Restoring means putting <code>data/</code> back in place and restoring the database dump before starting the stack. The API then rebuilds nothing; keys and blobs match by path.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
