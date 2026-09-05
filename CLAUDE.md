# CLAUDE.md — Vibe Recap

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Operational notes for Claude Code working in this repo. Read this first, then `docs/PLAN.md`, then `docs/PHASES.md`, then `STATE.md`.

> **Current state (2026-09-05):** all nine phases built and verified; v0.1.0 tagged. Source is
> public at `github.com/KisaesDevLab/Vibe-Recap`; images publish to GHCR from `.github/workflows/publish.yml`
> on every push to `main` (`latest`, `sha-*`) and on `v*.*.*` tags. Read `STATE.md` for what changed after
> the plan and `QUESTIONS.md` for every decision taken along the way.

## What this is

Vibe Recap is a standalone, self-hosted appliance for CPA firms. A preparer uploads a completed tax return package (v1: UltraTax CS client copies only, Q45; profiles for Lacerte, CCH Axcess, GoSystem, Drake and ProSeries exist but are unvalidated and skipped at upload). Recap extracts the key figures, generates a plain-English narrated video summary for the client, and lets the preparer review, approve, and download it for delivery through the firm's own channel. Everything runs on the firm's own hardware. No client data leaves the box.

It is a **separate product** from the rest of the Vibe suite. It shares conventions and the licensing server, not code or a database. It must install and run on its own with a single `docker compose up`.

## Execution model

- Work is organized in `docs/PHASES.md`. Execute one phase at a time. Implement every deliverable in the phase, run the phase's tests, update `STATE.md`, commit, and **stop**. Do not start the next phase without being told to.
- If a decision is needed that the plan does not settle, append it to `QUESTIONS.md` with your recommended answer, choose the recommended answer, note it in `STATE.md`, and keep going. Do not block on questions.
- Locked decisions in `docs/PLAN.md` §2 are not up for reinterpretation. If one appears to be wrong, record it in `QUESTIONS.md` and continue with the locked decision.
- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. One logical change per commit. Reference the phase, e.g. `feat(extract): 1040 line mapper (Phase 3)`.

## Stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS minimum (engines >=24), TypeScript strict |
| API | Fastify 5 |
| DB | PostgreSQL 16 (via Docker), Drizzle ORM + migrations |
| Queue | Redis 7 + BullMQ |
| UI | React 19 + Vite + Tailwind; no component framework, own primitives |
| Auth | Local accounts, Argon2id, session cookies (httpOnly, SameSite=Strict); WebAuthn passkeys optional in Phase 6 |
| Worker runtime | Python 3.12 (extraction + render pipeline), separate container |
| PDF text | pdfplumber (text-layer PDFs) |
| OCR fallback | GLM-OCR via Ollama, only when a page has no text layer |
| LLM | Ollama bundled in compose, `qwen3:8b` Q4_K_M default; `OLLAMA_URL` env overrides to an external instance; model name is a setting |
| TTS | Kokoro-82M via `kokoro-onnx`, CPU |
| Slides | HTML/Jinja2 → PNG via Playwright (Chromium) |
| Video | ffmpeg (libx264, aac, faststart) |
| Reverse proxy | Caddy (bundled), TLS via Tailscale cert, ACME, or self-signed |
| Storage | Local volume `/data`; encrypted at rest with age (per-file keys wrapped by a master key in `/data/keys`) |
| Backups | Duplicati sidecar (optional), same pattern as other Vibe apps |
| Scheduled jobs | node-cron inside `api` (hourly purge, daily license check) |
| Fixture generator | Python + ReportLab (`scripts/make-fixture.py`) |
| Images | GHCR `ghcr.io/kisaesdevlab/vibe-recap-{web,api,worker}` |
| License | PolyForm Small Business License 1.0.0 |

## Commands

The docs name these commands; they become real as each phase lands. Confirm against `package.json` / `pyproject.toml` once they exist and update this list.

| Task | Command |
|---|---|
| Full stack from clean checkout | `docker compose up --build` |
| Create first admin from CLI | `docker compose run api seed-admin` (or the `/setup` page while `users` is empty) |
| TS tests (api, web, shared) | `npm test` |
| Python tests (worker) | `pytest` from `worker/` |
| Single Python test | `pytest path/to/test_file.py::test_name` (pytest node-id syntax) |
| Regenerate synthetic fixtures | `python scripts/make-fixture.py` (Phase 3) |
| Health | `curl -k https://<host>/healthz` |
| Use host Ollama instead of bundled | set `OLLAMA_URL` in `.env`; scale `ollama` service to 0 |

## Target hardware

Reference box: GMKtec NucBox M6 — Ryzen 5 6600H (6c/12t), 32 GB DDR5, Radeon 660M, Ubuntu Server 24.04, Docker + Portainer. No discrete GPU. All model inference is CPU (Ollama may use the iGPU via ROCm if the host exposes it; never required).

Design for **serial job processing**. One recap job at a time regardless of how many were uploaded together; batches are a UI grouping, the worker never sees them. Concurrency is a setting, default 1. Never assume more than 12 GB free.

## Job pipeline and states (summary of PLAN.md §4)

Worker steps, in order:

```
ingest → identify → extract → [ocr] → recon → script → validate → verify → tts → slides → mux → ready
```

- `ocr` runs only when `identify` sees <20% text coverage on required pages.
- `validate` and `verify` are different gates and both are mandatory. `validate` proves every number in the script exists in `extraction.json`. `verify` proves those numbers and facts appear on the uploaded PDF by doing its own text pass. An extraction bug that yields a wrong-but-consistent JSON passes `validate` and must fail `verify`.
- `script` retries up to 3 times, feeding the validator's error back into the prompt.
- Slides render numbers from `extraction.json`, never from the script text.

Job states: `queued → processing → needs_review → approved → released → purged`, plus `failed` (records step + reason) and `rejected`.

Re-entry points, which the UI exposes as separate buttons:

| Action | Re-runs from |
|---|---|
| Retry (failed job) | the failed step |
| Re-extract | `identify` through `recon` only |
| Regenerate script | `script` → `validate` → `verify` |
| Save script (manual edit) | `validate` → `verify` (no audio until both pass) |
| Re-render (after reject or script edit) | `tts` |

Cross-cutting rules that are easy to miss:

- **Queue payload is `{ jobId }` only.** Never put file paths, names, or amounts in the BullMQ job data.
- **Approve snapshots three things**: script hash, extraction hash, and `verification.json`. Approve is refused if any is missing or stale.
- **Verifier independence**: `worker/recap/verify/` may share only the number-normalization helper with `extract/`; a test greps imports to enforce this.
- **Recon exceptions are per job**, require a ≥20-char reason, are audited, and the downgraded check still runs and still reports its mismatch.
- **Observations are deterministic Python**, not LLM output. The LLM only phrases numbers that already exist.
- **Batches are UI-only.** `batch_id` on `jobs` is nullable; bulk actions loop over jobs and write one audit row each with `bulk: true`.

## Non-negotiables

1. **Every dollar figure and percentage in a generated script must exist in the extracted JSON.** The validator (`worker/recap/validate.py`) rejects any script that fails this. There is no override.
1a. **Every amount and fact in the script must be verified against the uploaded return itself**, not just the extraction. The verifier (`worker/recap/verify/`) does its own text pass over the source PDF and traces each amount to a page and line label, recomputes percentages and YoY deltas from what it finds, and checks tax year, filing status, names, deduction type, refund-vs-owed direction, state presence, and PII absence. It must not import from `extract`. A job cannot reach `needs_review`, and Approve is disabled, while any verification item is flagged. Spec: `docs/PLAN.md` §5a.
2. **Arithmetic reconciliation gate.** Extracted 1040 lines must foot to the return's own totals within $1 before a script is generated. Failures surface to the preparer as an extraction problem, not a silent video.
3. **Preparer approval before release; delivery is download only.** No share links, no portal, no Vibe Connect. A video is never downloadable until a user with `preparer` or `admin` role clicks Approve. The approve action snapshots the script and the extracted JSON.
4. **No outbound network calls from the worker** except to the Vibe AI Router (via `airouter-proxy` on the egress-denied network; default script-generation provider since Kurt's 2026-09-05 decision, QUESTIONS.md Q37) and to Ollama (bundled container, or the host gateway when `OLLAMA_URL` points at the host). Enforce with an egress-denied network in compose plus socat relays for exactly those two targets. The API container may reach `licensing.kisaes.com` and the router only. There are no other integrations; do not add any. What leaves the box through the router is the script prompt (extracted figures, first names, filing status, states, preparer note), never the PDF; the router's task-class policy (`recap_script`) governs which provider serves it.
5. **Retention is enforced by a job, not by trust.** The purge worker runs hourly and is the only thing that deletes files. Purges are logged to the audit table. A thumbs-down on a job (Q46) holds its files for 90 days or until an admin dismisses it; the hold moves the date, it never adds a deleter.
6. **Extracted values are never hand-edited.** If a line is misread, the form profile is wrong. Fix the profile and re-extract. Recon failures may be downgraded to warnings per job by a preparer, with a reason, audited.
7. **No PII in logs.** Log job IDs and file hashes, never names, SSNs, or amounts. Redact structured logs at the logger level, not by convention.

## Repo layout

```
vibe-recap/
  CLAUDE.md
  STATE.md
  QUESTIONS.md
  README.md
  LICENSE
  docs/
    PLAN.md
    PHASES.md
    INSTALL.md
  compose.yml
  compose.override.example.yml
  .env.example
  Caddyfile
  apps/
    web/          React UI
    api/          Fastify API, auth, settings, retention, audit, licensing
  worker/
    recap/
      extract/    pdf text-layer mapper, form profiles, OCR fallback, recon gate
      script/     prompt template, Ollama client, validator
      verify/     independent script-to-return verifier (own PDF text pass; no imports from extract/)
      render/     slide templates, kokoro, playwright, ffmpeg
      jobs.py     BullMQ-compatible consumer (via `bullmq` Python package)
  packages/
    shared/       TS types shared by web + api (job status enums, DTOs)
  form-profiles/  YAML line maps per software + form (see Phase 3)
  tests/
    fixtures/     synthetic returns only — see below
```

## Test fixtures

Never commit a real tax return. `tests/fixtures/` contains synthetic 1040 packages generated by `scripts/make-fixture.py` with fake names, fake SSNs (`000-00-xxxx`), and figures that foot. Each fixture has a `.expected.json` next to it. A fixture for each supported software's PDF layout is a Phase 3 deliverable.

## Things that go wrong (read before touching the relevant area)

- **Ollama `num_ctx` defaults to 4096.** Set `num_ctx: 16384` in every request. The script prompt with a full extraction JSON exceeds 4k.
- **Qwen3 emits `<think>` blocks.** Strip them before validation. Prefer `/no_think` in the system prompt.
- **One script attempt can take minutes on CPU.** The prompt is ~1,500 tokens and the answer ~500; on the M6 that is a couple of minutes per attempt, on a laptop VM longer. The Ollama timeout is a setting (`ollama_timeout_s`, default 600); a 180 s timeout fails every job at `script`.
- **pdfplumber on Lacerte output** reports overlapping words on some lines; use `extract_words(use_text_flow=True)` and cluster by `top` before joining.
- **UltraTax prints line labels and values in separate text runs**, the value about 4 points *above* its label, with the IRS line number repeated at x≈478 just left of the amount column. The profile uses a tight row band (3), a value zone from x=500, and `orphan_y_tolerance` to attach value rows; a wide band glues a value to the row above it instead.
- **UltraTax client copies are 79 to 85 pages.** Summary, letters, filing instructions and the e-file authorization come first; the return starts a dozen pages in; a second copy of the federal pages follows the state return; worksheets and reports quote every form name and line label. Federal page classifiers require the OMB number (page 1, schedules) or the "Form 1040 (year) … Page 2" header; state pages are grouped with their continuation pages; `identify` reads year and names from the form page, never from page 1.
- **The real 2025 Form 1040 renumbers lines**: 7a, 11a (page 1), 11b, 12e, 13a, 13b (Schedule 1-A deductions), 27a. `line:` in a profile takes a list of alternatives. Line 37 includes the line 38 penalty and states fold their penalty into the amount due; the recon checks accept that identity and record `penalty_included`.
- **Real returns for testing** live in `tests/fixtures/real/` (gitignored). Never commit one; never print names or amounts from them into chat, logs, or commits.
- **Playwright in Docker** needs `--no-sandbox` and `shm_size: 1g` or Chromium will crash on the second render.
- **ffmpeg concat with per-image durations** requires the `-f concat` demuxer with a durations file; the last image must be listed twice or it is dropped.
- **Kokoro sentence timing.** Generate per-sentence WAVs and record durations; drive slide transitions from those durations, not from word counts.
- **Argon2id in Node** needs the native `argon2` package; alpine images need `build-base` at build time. Use the `-bookworm-slim` base.
- **Batch staging lives in Redis, not Postgres.** Staged-but-unqueued rows expire after 1 h; do not create `jobs` rows until the preparer clicks Queue.
- **BullMQ from Python** requires the job data shape to be plain JSON and the queue name to match exactly (`recap`).

## Definition of done for any phase

- All deliverables implemented.
- `npm test` and `pytest` green.
- `docker compose up --build` from a clean checkout produces a working stack on the reference box.
- `STATE.md` updated: phase status, deviations, what the next phase should know.
- Commit and stop.
