# Vibe Recap — Phased Build Plan

Execute one phase at a time. Each phase ends with tests green, `STATE.md` updated, a commit, and a stop. Rough effort is for a single autonomous Claude Code session on the reference box; treat it as a sanity check, not a deadline.

---

## Phase 1 — Skeleton, compose, auth, first admin

**Goal:** A clean checkout comes up with `docker compose up --build`, serves a login page over Caddy, and lets the first admin create their account.

**Deliverables**
1. Repo layout per `CLAUDE.md`. `LICENSE` (PolyForm Small Business 1.0.0), `README.md`, `.env.example`, `compose.yml` with `caddy`, `web`, `api`, `postgres`, `redis`, `ollama`, `worker` (worker is a stub that connects to Redis and idles).
2. `Caddyfile` with three modes selected by env: `tailscale` (Tailscale cert), `domain` (ACME), `lan` (internal CA, self-signed). Default `lan`.
3. `api`: Fastify 5, TypeScript, Drizzle ORM, migrations. Tables: `users`, `sessions`, `audit_events`, `settings`, `licenses`.
4. Auth: local accounts, Argon2id, session cookies, CSRF token for state-changing requests, rate limit on `/auth/login` (10/min/IP), account lockout after 10 failures for 15 min.
5. `/setup` route + page: only mounted while `users` is empty; creates first `admin`; disables itself.
6. `web`: Vite + React + Tailwind shell, router, auth context, login page, empty dashboard, top nav with role-aware links.
7. Audit helper `audit(actor, action, target, meta)` used by login/logout/setup.
8. Health endpoints `/healthz` (api) and readiness that checks Postgres, Redis, Ollama reachability (Ollama down = degraded, not failed).
9. `docs/INSTALL.md` first draft: prerequisites, `.env`, first run, first admin.

**Tests**
- Unit: password hashing, session expiry, CSRF rejection.
- Integration: setup page appears on empty DB, disappears after first admin, login works, lockout triggers.
- Compose: `docker compose up --build` on the M6 succeeds; `curl -k https://<host>/healthz` returns 200.

**Success criteria**
- Kurt can reach the login page on the M6 over Tailscale, create the admin, log in, and see an empty dashboard.
- `worker` container starts, logs "connected to redis, waiting", and has no route to the internet (`curl https://example.com` from inside it fails).

---

## Phase 2 — Upload, storage, encryption, clients, job records

**Goal:** A preparer can upload one PDF or a batch of PDFs; each becomes its own encrypted, independently queued job; the dashboard shows them individually and as a batch.

**Deliverables**
1. Tables: `clients` (name, external_ref, retention overrides, legal_hold), `batches` (id, uploaded_by, created_at, file_count, note), `jobs` (status, step, client_id, batch_id nullable, uploaded_by, tax_year, software, hashes, timestamps for each state), `files` (job_id, kind: `source|prior|extraction|script|audio|slide|video|vtt|txt`, path, sha256, size, key_id, purged_at), `job_events` (step transitions and errors).
2. Storage service: write blob to `/data/blobs/<job>/<kind>` encrypted with `age` using a fresh per-file key; wrap the key with the master key from `/data/keys/master.key` (created on first run; optional `MASTER_KEY_PASSPHRASE` env). Read path streams decrypt. Shred = overwrite wrapped key + unlink.
3. Upload endpoint: multipart, accepts 1–200 files or one ZIP (expanded server-side, nested folders flattened, non-PDF entries ignored and reported), max 100 MB per PDF / 2 GB per batch, PDF magic-byte check, reject encrypted PDFs per file with a clear message (other files continue), sha256, dedupe warning if same hash exists for same client within 30 days.
3a. Staging pass (synchronous, first page only, pdfplumber, <1 s/file): taxpayer first/last name, tax year, software signature. Client auto-match: exact name → match; trigram similarity ≥ 0.85 → suggested; else "new client" prefilled. Prior-year auto-pairing: two files, same name, tax years N and N−1 → paired as source + prior. Staging rows are held in Redis for 1 h, not in the DB, until the preparer queues them.
3b. Queue action creates the `batch` row and one `jobs` row per staged file, enqueues each separately. Partial queueing allowed (uncheck rows).
4. UI: `/upload` page with the staging table (per PLAN.md §8): editable client cell with inline create, tax year override, prior-year pairing, notes, "Queue N jobs"; `/batches/:id` page with progress, per-job status, Retry on failed; `/clients` list and detail; dashboard queue cards plus an "Active batches" strip.
5. Job enqueue to BullMQ `recap` queue with `{ jobId }` only — never file paths or client data in the queue payload.
6. Audit events: `client.create`, `batch.create`, `job.upload` (one per file, carries `batch_id`), `job.retry`, `file.read` (on any decrypt for download/preview).

**Tests**
- Encrypt/decrypt round trip; shredded file cannot be decrypted; master key rotation script re-wraps all keys.
- Upload rejects non-PDF, oversize, encrypted PDF.
- Job appears in queue with correct payload shape.
- Batch of 25 fixture PDFs (mixed software, two with prior-year pairs, one encrypted, one non-PDF inside the ZIP) stages correctly: 24 rows, 2 auto-paired, the encrypted one reported and skipped, the non-PDF reported and skipped; auto-match hits the right client for every fixture with an existing client record.
- Worker processes the batch serially; killing the worker mid-job leaves that one job `failed` and the rest continue after restart.

**Success criteria**
- Upload of a fixture PDF lands as an encrypted blob; `strings` on the blob shows no plaintext; job visible in dashboard as `queued`.
- A 25-file batch queues in one action and the batch page shows 25 independent jobs.

---

## Phase 3 — Extraction: identify, form profiles, 1040 line mapper, recon gate

**Goal:** The worker turns a 1040 package into `extraction.json` that passes the reconciliation gate, for every supported software's layout.

**Deliverables**
1. `scripts/make-fixture.py`: generates synthetic 1040 packages (federal + one state) in each supported layout using ReportLab, mimicking label/value geometry of UltraTax, Lacerte, CCH Axcess, GoSystem, Drake, ProSeries. Each with `.expected.json`. Figures foot. Fake names, `000-00-xxxx` SSNs.
2. `identify`: reads first 3 pages' text; detects software by known header/footer signatures; detects tax year and form; text-coverage % across all pages.
3. `form-profiles/1040-<year>-<software>.yaml`: line label patterns → schema paths, with page hints and y-band tolerances. Profiles are data, not code; adding a software must not require Python changes.
4. `extract`: pdfplumber word extraction with `use_text_flow=True`, y-band clustering, label matching per profile, numeric parsing (parentheses negatives, thousands separators, trailing `-`).
5. Prior-year: if a prior-year PDF was supplied, run the same extractor and fill `prior_year`; else attempt to read a "two-year comparison" page if the software prints one.
6. `observations`: deterministic Python, not LLM — YoY AGI delta, YoY total tax delta, refund vs prior refund, withholding vs total tax ratio, unused standard-vs-itemized proximity (within 10%), estimated-tax underpayment flag (from Form 2210 presence).
7. `recon`: total_income foots from components; AGI = total_income − adjustments; taxable_income = AGI − deductions − QBI (floor 0); total_tax = tax + schedule_2 − nonrefundable_credits + other_taxes; result = total_payments − total_tax with sign; each state's result likewise. Tolerance $1. Any failure → job `failed` at step `recon` with the list of mismatches shown in the UI.
8. UI: job detail shows extraction table grouped by section (read-only — no hand edits, L15), recon check list with ✓/✗, and a "Re-extract" button (re-runs `identify`→`recon` only).
9. Recon exceptions (L16): on a failed job, a `preparer` or `admin` can downgrade one or more named checks to warnings with a required reason (min 20 chars). Stored on the job, audited (`job.recon_exception`), shown as ⚠ in the UI and in the verification panel forever after. Re-running recon honors the exception for that job only. A downgraded check still runs and still reports the mismatch.

**Tests**
- Every fixture extracts to match `.expected.json` exactly.
- Mutated fixture (one wrong line) fails recon with the correct check named.
- Unknown software falls back to a generic profile and either succeeds or fails recon cleanly.

**Success criteria**
- 6/6 software fixtures pass. A real UltraTax return from Kurt's practice (run locally, never committed) extracts and passes recon.

---

## Phase 4 — OCR fallback

**Goal:** Scanned or image-only pages get a text layer via GLM-OCR so Phase 3 can proceed.

**Deliverables**
1. Worker pulls `glm-ocr` into Ollama on first use (or at compose start via an init container, configurable).
2. When text coverage < 20% on required pages, rasterize those pages at 200 dpi and OCR them; merge OCR words with coordinates into the same structure pdfplumber produces so profiles apply unchanged.
3. Per-page cap of 90 s; job fails cleanly at `ocr` with "scanned pages exceeded time limit" if exceeded.
4. Setting: OCR enabled/disabled (default enabled). Status page shows model presence.

**Tests**
- Rasterized fixture (PDF → PNG → PDF) extracts and passes recon.

**Success criteria**
- A scanned fixture completes on the M6 in under 6 minutes for a 12-page package.

---

## Phase 5 — Script generation and validator

**Goal:** From `extraction.json` and firm settings, produce a slide-tagged narration script that is validated against the extraction **and verified against the uploaded return itself** (PLAN.md §5a).

**Deliverables**
1. Prompt template `worker/recap/script/prompt.jinja`: greeting uses first name(s) only, from `taxpayer`, with a setting to use a generic greeting instead (L18); all states in the package are covered — resident state in detail, others by result only (L20). System prompt establishes voice (warm, plain English, second person, no jargon, no advice beyond "we'll discuss at your review"), hard rules (only use numbers in the JSON; format currency as provided; no speculation on law changes), and a fixed slide order with tags `[[slide:greeting]]`, `[[slide:income]]`, `[[slide:deductions]]`, `[[slide:tax]]`, `[[slide:result]]`, `[[slide:observations]]`, `[[slide:next]]`. Preparer notes are injected as "the preparer wants you to mention: …".
2. Ollama client: `num_ctx 16384`, `temperature 0.3`, `/no_think`, strip `<think>`; timeout 180 s; 3 attempts with the validator's error message fed back.
3. Validator: extracts every `$X`, `X%`, and bare numbers ≥ 100 from the script; each must equal (after normalization) a value in `extraction.json` or a whitelisted computed value (delta, pct from `observations`). Also enforces: all seven slide tags present and in order, 250–450 words, no SSN pattern, no address, no email.
4. Script stored as `script.md` with the extraction snapshot hash it was generated from.
5. UI: script editor on job detail with live validator feedback (client-side mirror of the rules plus server confirmation on save), word count, per-slide preview text, "Regenerate" (new LLM pass) and "Save" (manual edit; still must validate and verify).
5a. **Verifier** (`worker/recap/verify/`): independent of `extract`; own pdfplumber text pass over the source PDF (and prior-year PDF if present). Implements every check in PLAN.md §5a: amounts traced to page + label, percentages and YoY deltas recomputed from amounts found on the return, tax year / filing status / names / deduction type / refund-vs-owed direction / state presence matched against the return's own text, PII absence, and coverage. Emits `verification.json` with per-item page/label evidence. Runs after `validate` and again on every manual script save. Job cannot enter `needs_review` with a failed item.
5b. UI "Verification" panel on the job page: every item with ✓/✗, reason on failure, click-to-open the source PDF at the matched page with the text highlighted. Approve button disabled while any item is flagged. Approve stores `verification.json` with the script and extraction snapshot.
6. Setting: model name, Ollama URL, temperature, target length, firm sign-off sentence.

**Tests**
- Validator rejects a script with a number not in JSON; accepts golden scripts for each fixture.
- Script generation for each fixture passes validation within 3 attempts on `qwen3:8b`.
- Manual edit that introduces `$1,234` not in JSON is rejected in UI and API.
- Verifier: for each fixture, every amount in the golden script traces to the expected page/label. A fixture whose extraction JSON is deliberately corrupted (AGI swapped with taxable income) passes `validate` but **fails `verify`** with the right item flagged. A script that says "refund" for an amount-owed fixture fails the direction check. A script mentioning a YoY change with no prior-year source fails. A script containing the fixture's fake bank account number fails the absence check.
- Verifier has no import of `worker/recap/extract` (enforced by a test that greps imports).

**Success criteria**
- Kurt reads generated scripts for 3 fixtures and judges them client-appropriate without edits on at least 2.

---

## Phase 6 — Render: TTS, slides, video, captions; review and approval

**Goal:** A `needs_review` job has a playable video; a preparer can approve or reject. Passkeys/TOTP are optional deliverables here — if the phase runs long, defer TOTP first, then passkeys, to v1.1 (Q8).

**Deliverables**
1. Kokoro-82M via `kokoro-onnx`, CPU; four bundled voices (2 female, 2 male, American English; default `af_heart`), firm picks one in settings; per-sentence WAV with duration; sentences grouped by slide tag.
2. Slide templates (Jinja2 + HTML/CSS, 1920×1080): greeting, income, deductions, tax, result, observations, next steps. Firm logo, name, primary/secondary colors from settings. All numbers rendered from `extraction.json`, never from the script. Charts drawn as inline SVG (income composition bar, tax vs payments).
3. Playwright renders each slide to PNG (`--no-sandbox`, `shm_size`).
4. ffmpeg: concat demuxer with durations, 0.4 s crossfade, h264 CRF 23, AAC 128k, `+faststart`. Also emit `recap.vtt` from sentence timings and `recap.txt` (full script) for accessibility.
5. Job → `needs_review`. UI: video player, caption toggle, side-by-side script, extraction summary, Approve (snapshots script + extraction hash, → `approved`), Reject with reason (→ `rejected`; editing script and clicking "Re-render" re-runs from `tts`).
5b. Batch page: "Approve all verified" — approves every `needs_review` job in the batch with zero verification flags and no recon exceptions; jobs with warnings or exceptions are listed and must be approved one at a time. One audit row per job, actor = user, meta `bulk: true`.
6. Optional passkeys (WebAuthn) and TOTP for users, settings toggles.

**Tests**
- End-to-end fixture → MP4 exists, duration within ±10% of sum of WAV durations, VTT cue count = sentence count.
- Approve is refused for `staff`/`viewer`; refused if script hash ≠ current script; refused if `verification.json` is missing, stale (hash mismatch), or has any flagged item.

**Success criteria**
- 70–120 s wall time per fixture on the M6. Video plays in browser. Kurt approves one.

---

## Phase 7 — Release and download

**Goal:** Approved videos can be released and downloaded in a controlled, audited way. Delivery is download only (L11).

**Deliverables**
1. Release action (`preparer`/`admin`): → `released`, timestamps, audit.
2. Downloads (MP4, VTT, TXT, extraction JSON, verification JSON, source PDF) gated by role and state; every download audited with user, IP, file kind, sha256.
3. "Download package" button: one ZIP with MP4 + VTT + TXT, filename `<client>-<year>-recap.zip`, so a preparer can attach it to the firm's existing secure-delivery channel in one step.
4. Dashboard filters: needs review / approved not released / released this week.
4a. Batch page: "Release all approved" and "Download all released" (one outer ZIP containing each job's package ZIP). Each job still gets its own audit row.
5. Job page shows a "Delivered" checkbox + free-text note (e.g. "sent via portal 9/12") for the preparer's own tracking; audited.

**Tests**
- Download of a `needs_review` video by `staff` is refused; `viewer` can download only `released` MP4/VTT/TXT, never source PDF or JSON.
- ZIP contents match individual downloads byte-for-byte.
- Every download produces exactly one audit row.

**Success criteria**
- Kurt releases a fixture video, downloads the package, and the audit log shows who downloaded what and when.

---

## Phase 8 — Retention engine and purge

**Goal:** Files disappear on schedule, provably.

**Deliverables**
1. Settings page `/settings/retention`: source PDF days, extraction+script days, video days, failed-job days; per-client default section; help text explaining each.
2. Client detail: retention override fields, legal-hold toggle (admin only), "purge this client now" (admin, confirm by typing client name).
3. Purge worker in `api` (node-cron, hourly): computes due files per policy, honors legal hold, shreds keys, unlinks blobs, sets `files.purged_at`, moves job to `purged` when all files gone except audit; audit event per file with policy reason.
4. "Purge now" admin action runs the same function with a dry-run preview first (lists what would go).
5. Retention report: `/settings/retention` shows counts by kind due in next 7 days; CSV export.
6. Startup self-check: if `/data/blobs` contains files with no DB row, log and quarantine to `/data/orphans` (never silently delete).

**Tests**
- Time-travel test (inject `now`) proves files purge exactly at window edge, not before.
- Legal hold blocks purge; clearing it purges on next run.
- Orphan detection works.

**Success criteria**
- Kurt sets source retention to 0 days, uploads, and the source PDF is gone within one purge cycle after `ready`, with the audit row present.

---

## Phase 9 — User management, audit UI, licensing, backup, install docs

**Goal:** Everything an admin needs to run this at a firm, and everything Kurt needs to sell it.

**Deliverables**
1. `/settings/users`: list, create (with temp password or invite link valid 24 h), edit role, disable, reset password, force logout, view passkeys/TOTP status, last login. Cannot demote or disable the last admin.
2. `/settings/audit`: filter by actor, action, client, date; paginated; CSV export; retention note (never auto-purged).
3. Licensing: key entry, validation against `licensing.kisaes.com` (daily, with 14-day grace offline), seat count (users). Unlicensed = read-only after grace.
4. `/settings/general`: firm branding (logo upload, colors, sign-off sentence), voice, model, concurrency, Ollama URL, OCR toggle; "Test Ollama" button.
5. `/settings/backup`: export settings + form profiles as JSON, import with merge/replace; Duplicati sidecar instructions; note that blobs are encrypted and require `/data/keys` to restore.
6. `docs/INSTALL.md` final: fresh Ubuntu 24.04 → working app in under 20 minutes; Tailscale/domain/LAN modes; updating via `docker compose pull`; troubleshooting table.
7. GHCR publish workflow; image tags `vX.Y.Z` and `latest`; SBOM attached.
8. `README.md` final with screenshots.

**Tests**
- Last-admin protection; invite link expiry; license grace behavior with licensing server unreachable.
- Settings export/import round trip.

**Success criteria**
- A CPA who is not Kurt follows INSTALL.md on a fresh host and produces a released recap video from a fixture without contacting Kurt. **This is the ship gate.**

---

## Phase 10 (v1.1, after ship) — Business returns and T&B client sync

Not scheduled. Captured so the schema in Phase 2 leaves room: `jobs.form` is free text, `form-profiles/` is namespaced by form, `clients.external_ref` exists for T&B ids.

---

## Phase completion log

Append as phases complete:

```
- Phase N completed YYYY-MM-DD by <author>. Deviations: <none | description>. Test host: <host>.
```

- Phase 1 completed 2026-09-05 by Claude Code. Deviations: none. Test host: Windows 11 dev box (Docker Desktop); not yet run on the M6.
- Phase 2 completed 2026-09-05 by Claude Code. Deviations: staging runs in the worker over a second queue (Q11); the mid-job worker-kill test moved to Phase 3. Test host: Windows 11 dev box.
- Phase 3 completed 2026-09-05 by Claude Code. Deviations: re-extract continues through the pipeline (Q16). Test host: Windows 11 dev box.
- Phase 4 completed 2026-09-05 by Claude Code. Deviations: tested with a stand-in OCR engine; real GLM-OCR output format unverified (Q19). Test host: Windows 11 dev box.
- Phase 5 completed 2026-09-05 by Claude Code. Deviations: none. Test host: Windows 11 dev box.
- Phase 6 completed 2026-09-05 by Claude Code. Deviations: ffmpeg xfade instead of the concat demuxer for video (Q23); passkeys/TOTP deferred (Q25). Test host: Windows 11 dev box.
- Phase 7 completed 2026-09-05 by Claude Code. Deviations: none. Test host: Windows 11 dev box.
- Phase 8 completed 2026-09-05 by Claude Code. Deviations: source retention anchored on ready/failed rather than upload (Q29). Test host: Windows 11 dev box.
- Phase 9 completed 2026-09-05 by Claude Code. Deviations: licensing contract assumed (Q31); ship gate (a non-author CPA on a fresh host) not yet exercised. Test host: Windows 11 dev box.
