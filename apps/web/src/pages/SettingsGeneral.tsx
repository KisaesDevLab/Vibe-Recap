import { useState, type FormEvent } from "react";
import { useApi } from "../lib/useApi";
import { ApiError, post, put } from "../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, Select, Spinner } from "../ui";

interface GeneralResponse {
  settings: {
    firm_name: string;
    firm_logo: string | null;
    color_primary: string;
    color_secondary: string;
    signoff_sentence: string;
    voice: string;
    llm_provider: "router" | "ollama";
    router_model: string;
    model_name: string;
    ollama_url: string;
    temperature: number;
    ollama_timeout_s: number;
    target_words: number;
    concurrency: number;
    ocr_enabled: boolean;
    greeting_use_first_names: boolean;
  };
  defaults: { ollama_url: string; model_name: string; ocr_model: string };
  voices: Record<string, string>;
  note: string;
}

export function SettingsGeneralPage() {
  const { data, loading, error, reload } = useApi<GeneralResponse>("/api/settings/general");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [ollama, setOllama] = useState<{
    reachable: boolean;
    hasModel: boolean;
    hasOcrModel: boolean;
    models: string[];
    url: string;
    model: string;
    router: { configured: boolean; url: string; reachable: boolean; registered: Array<{ key: string; sensitivity: string }> | null; error: string | null };
  } | null>(null);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error ?? "Could not load"}</Alert>;
  const s = data.settings;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      firm_name: fd.get("firm_name"),
      color_primary: fd.get("color_primary"),
      color_secondary: fd.get("color_secondary"),
      signoff_sentence: fd.get("signoff_sentence"),
      voice: fd.get("voice"),
      llm_provider: fd.get("llm_provider"),
      router_model: fd.get("router_model"),
      model_name: fd.get("model_name"),
      ollama_url: fd.get("ollama_url"),
      temperature: Number(fd.get("temperature")),
      ollama_timeout_s: Number(fd.get("ollama_timeout_s")),
      target_words: Number(fd.get("target_words")),
      concurrency: Number(fd.get("concurrency")),
      ocr_enabled: fd.get("ocr_enabled") === "on",
      greeting_use_first_names: fd.get("greeting_use_first_names") === "on",
    };
    if (logo !== undefined) body.firm_logo = logo;
    setBusy(true);
    setMsg(null);
    try {
      await put("/api/settings/general", body);
      await reload();
      setMsg({ kind: "success", text: "Saved." });
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function testOllama(form: HTMLFormElement | null) {
    setBusy(true);
    try {
      const fd = form ? new FormData(form) : null;
      const r = await post<typeof ollama>("/api/settings/test-ollama", { ollama_url: fd?.get("ollama_url") || undefined, model_name: fd?.get("model_name") || undefined });
      setOllama(r);
    } catch (err) {
      setMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Test failed" });
    } finally {
      setBusy(false);
    }
  }

  function onLogo(file: File | null) {
    if (!file) return setLogo(null);
    if (file.size > 200 * 1024) return setMsg({ kind: "error", text: "Logo must be under 200 KB" });
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  }

  return (
    <>
      <PageTitle>General</PageTitle>
      {msg && (
        <div className="mb-4">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <form id="general" onSubmit={save} className="grid gap-4 lg:grid-cols-2">
        <Card title="Firm branding">
          <div className="space-y-3">
            <Field label="Firm name">
              <Input name="firm_name" defaultValue={s.firm_name} />
            </Field>
            <Field label="Logo" hint="PNG, JPEG, SVG, or WebP up to 200 KB. Shown on every slide.">
              <div className="flex items-center gap-3">
                {(logo === undefined ? s.firm_logo : logo) && <img src={(logo === undefined ? s.firm_logo : logo) ?? ""} alt="" className="h-12 max-w-40 object-contain" />}
                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(e) => onLogo(e.target.files?.[0] ?? null)} />
                {(logo ?? s.firm_logo) && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setLogo(null)}>
                    Remove
                  </Button>
                )}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Primary color">
                <Input name="color_primary" type="color" defaultValue={s.color_primary} className="h-10 p-1" />
              </Field>
              <Field label="Secondary color">
                <Input name="color_secondary" type="color" defaultValue={s.color_secondary} className="h-10 p-1" />
              </Field>
            </div>
            <Field label="Sign-off sentence" hint="Closes every script, verbatim.">
              <Input name="signoff_sentence" defaultValue={s.signoff_sentence} />
            </Field>
            <Field label="Default narration voice" hint="Used when a user has not picked their own voice under Your account.">
              <Select name="voice" defaultValue={s.voice}>
                {Object.entries(data.voices).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="greeting_use_first_names" defaultChecked={s.greeting_use_first_names} /> Greet clients by first name (from the return)
            </label>
          </div>
        </Card>
        <Card title="Language model and processing">
          <div className="space-y-3">
            <Field label="Script generation provider" hint="Vibe AI Router serves the firm's configured cloud or local models under the router's data-boundary policy; only the extracted figures and first names are sent, never the PDF. Bundled Ollama keeps everything on this box.">
              <Select name="llm_provider" defaultValue={s.llm_provider}>
                <option value="router">Vibe AI Router (task class recap_script)</option>
                <option value="ollama">Bundled Ollama (local only)</option>
              </Select>
            </Field>
            <Field label="Router model (advisory)" hint="The router's policy decides what serves; leave blank to accept its default for recap_script.">
              <Input name="router_model" defaultValue={s.router_model} placeholder="policy default" />
            </Field>
            <Field label="Ollama URL" hint={`Blank uses ${data.defaults.ollama_url}`}>
              <Input name="ollama_url" defaultValue={s.ollama_url} placeholder={data.defaults.ollama_url} />
            </Field>
            <Field label="Model" hint={`Blank uses ${data.defaults.model_name}`}>
              <Input name="model_name" defaultValue={s.model_name} placeholder={data.defaults.model_name} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Temperature">
                <Input name="temperature" type="number" step="0.1" min={0} max={1.5} defaultValue={s.temperature} />
              </Field>
              <Field label="Target words">
                <Input name="target_words" type="number" min={250} max={450} defaultValue={s.target_words} />
              </Field>
              <Field label="Concurrency">
                <Input name="concurrency" type="number" min={1} max={4} defaultValue={s.concurrency} />
              </Field>
            </div>
            <Field label="Model timeout (seconds)" hint="How long one script attempt may take. CPU-only boxes need several minutes; 600 is a safe default.">
              <Input name="ollama_timeout_s" type="number" min={60} max={3600} defaultValue={s.ollama_timeout_s} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="ocr_enabled" defaultChecked={s.ocr_enabled} /> OCR fallback for scanned pages ({data.defaults.ocr_model})
            </label>
            <p className="text-xs text-slate-500">{data.note}</p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => testOllama(document.getElementById("general") as HTMLFormElement)}>
                Test connections
              </Button>
            </div>
            {ollama && (
              <div className="space-y-1 text-xs">
                <div>
                  <strong>Ollama:</strong>{" "}
                  {ollama.reachable ? (
                    <>
                      reachable at {ollama.url}; model {ollama.model} {ollama.hasModel ? "present" : "MISSING"}; OCR model {ollama.hasOcrModel ? "present" : "missing"}
                    </>
                  ) : (
                    <span className="text-red-700">not reachable at {ollama.url}</span>
                  )}
                </div>
                <div>
                  <strong>AI Router:</strong>{" "}
                  {!ollama.router.configured ? (
                    <span className="text-amber-700">no app token (VIBE_AI_TOKEN); scripts use the bundled Ollama</span>
                  ) : ollama.router.error ? (
                    <span className="text-red-700">{ollama.router.error}</span>
                  ) : (
                    <>
                      reachable at {ollama.router.url}; task classes {ollama.router.registered?.map((r) => `${r.key} (${r.sensitivity})`).join(", ")}
                      {ollama.router.registered?.some((r) => r.sensitivity === "local_only") && " — widen recap_script in the router console to use cloud models"}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>
        <div className="lg:col-span-2">
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </>
  );
}
