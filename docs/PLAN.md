# Vibe Recap — Design Plan

## 1. Purpose

Give tax clients a two-to-three minute narrated video that explains their return in plain English: what they earned, what they paid, why the refund or balance due is what it is. It accompanies the delivered return: the recap closes by telling the client their complete copy is on its way and to contact the firm with any questions (amended 2026-09-11, QUESTIONS.md Q50). Preparers upload the finished return package, review the generated script, approve, and send. The firm keeps every byte on its own hardware.

Positioning inside the Vibe suite: a **standalone appliance** with its own UI, users, storage, and retention rules. It does not require any other Vibe product. Delivery is download only: the preparer downloads the approved video and sends it through whatever channel the firm already uses. No portal, no share links, no integrations in v1.

## 2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| L1 | Standalone app, own Postgres, own auth. | User asked for a separate app; keeps install trivial. |
| L2 | v1 supports Form 1040 packages only. 1120-S / 1065 / 1041 are v2. | 1040 is 80%+ of client-facing volume and the only form where a "your results" narrative is straightforward. |
| L3 | Text-layer extraction is primary; OCR is fallback only. | Firm-generated PDFs always have a text layer; skipping OCR is what makes the M6 sufficient. |
| L4 | Default LLM is `qwen3:8b` on Ollama, CPU. Model is a setting. | Slot-filling task; 8B is enough. Larger boxes can swap models without code change. |
| L5 | Video = HTML slides rendered to PNG + Kokoro narration + ffmpeg. No avatars, no generative video. | Deterministic, cheap, every on-screen number comes from extracted JSON. |
| L6 | Script validator is a hard gate; no override path in UI or API. | The single biggest risk is a wrong number reaching a client. |
| L7 | Preparer approval required before a video becomes downloadable. | Professional responsibility; also the natural QA step. |
| L8 | Files encrypted at rest with per-file `age` keys; master key on local disk, optionally passphrase-wrapped. | Matches FTC Safeguards expectations; cheap to implement. |
| L9 | Retention: per-firm default policy plus per-client override; enforced by hourly purge job with audit log. | Explicit user requirement. |
| L10 | Roles: `admin`, `preparer`, `staff`, `viewer`. | Enough for a small firm; see §6. |
| L11 | Delivery is download only. No share links, no client portal, no Vibe Connect or other integrations. | Kurt's decision 2026-09-03. Smallest attack surface; the firm already has a delivery channel. |
| L12 | Worker container has no egress except to `ollama` on the internal network. API container's only outbound destination is `licensing.kisaes.com`. | §7216 posture must be enforceable, not just documented. |
| L14 | Ollama is bundled in compose; `OLLAMA_URL` overrides to an external instance (on the M6: the host's existing Ollama, bundled service scaled to 0). | Q1. |
| L15 | Extracted values are never hand-edited. Wrong extraction = wrong form profile; fix the profile and re-extract. | Q2. |
| L16 | Recon gate exceptions: a `preparer` may downgrade a named check to a warning with a written reason; audited; the job proceeds. The downgrade is per job, never global. | Q10. |
| L17 | One firm per install. No multi-tenancy. | Q7. |
| L18 | Greeting uses first name(s) only, from the return; setting to disable. | Q5. |
| L19 | Bundled Kokoro voices (16 English ones exposed, all already in `voices-v1.0.bin`). The firm picks a default in settings; each user may pick their own under Your account; and one job can be re-rendered in another voice from its own page (amended 2026-09-11, QUESTIONS.md Q51, Q54, Q55). | Q3. |
| L20 | All states in the package are summarized; resident state in detail, others by result only. | Q9. |
| L21 | Source PDF default retention 30 days. | Q6. |
| L22 | Batch upload: many PDFs (or a ZIP of PDFs) in one action; each PDF becomes its own independent job. Client is auto-matched from the taxpayer name on the return and confirmed by the preparer before the batch is queued. Jobs process serially; one failure never blocks the others. | Kurt 2026-09-03. |
| L13 | PolyForm Small Business License 1.0.0; licensed via `licensing.kisaes.com`; distributed via GHCR. | Same as the rest of the suite. |

**Amendment 2026-09-05 (Kurt, Q&A):** L4 and L12 are amended. Script generation goes through the
Vibe AI Router (`http://vibe-ai-router:8220` on `vibe_net`, task class `recap_script`) by default,
serving DigitalOcean serverless open-source models under the router's data-boundary policy; the
bundled Ollama stays available as the local provider. The worker's egress is the router and Ollama,
nothing else. See QUESTIONS.md Q37.

**Amendment 2026-09-05 (Kurt, Q48):** L12 is amended again for the API container only: it may
also reach `api.emailit.com` to send transactional email to the firm's own users (invites,
password-reset links, password-changed notices). Off until an admin enables it under Settings ›
Email. The worker's egress is unchanged. Recap still never emails clients.

**Amendment 2026-09-05 (Kurt, Q49):** L13's "licensed via `licensing.kisaes.com`" is withdrawn. The
product stays under the PolyForm Small Business License but has no license key, no licensing
server, no seat count, and no read-only mode. L12's API egress is therefore the router and
Emailit only.

## 3. Architecture

```
┌───────────────────────────── firm host (NucBox M6) ─────────────────────────────┐
│                                                                                 │
│  Caddy :443 ──► web (React, static)                                             │
│             └─► api (Fastify :3000) ──► Postgres 16                             │
│                                     ──► Redis 7 (BullMQ queue "recap")          │
│                                     ──► /data (age-encrypted files)             │
│                                                                                 │
│  worker (Python) ◄── BullMQ consumer                                            │
│     extract ─► recon gate ─► script (Ollama :11434) ─► validate ─► verify ─► render │
│     └── egress-denied network; only route is to `ollama`                        │
│                                                                                 │
│  ollama (qwen3:8b, glm-ocr)                                                     │
│  purge (hourly cron in api) ─► deletes per retention policy, writes audit       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Containers: `caddy`, `web`, `api`, `worker`, `ollama`, `postgres`, `redis`. Optional: `duplicati`.

## 4. Job pipeline

| Step | Input | Output | Fails if |
|---|---|---|---|
| `ingest` | uploaded PDF | encrypted blob, sha256, page count, text-layer % | not a PDF, >200 pages, encrypted PDF |
| `identify` | first 3 pages text | software (UltraTax/Lacerte/CCH/GoSystem/Drake/ProSeries/unknown), tax year, form | tax year missing |
| `extract` | PDF + form profile | `extraction.json` (schema in §5) | required lines missing |
| `ocr` (conditional) | pages with no text layer | text | only used when `identify` sees <20% text coverage |
| `recon` | extraction.json | pass/fail + list of mismatches | any total off by >$1 |
| `script` | extraction.json + firm settings | `script.md` (sentences tagged to slide IDs) | Ollama unreachable; validator fails after 3 attempts |
| `validate` | script.md + extraction.json | pass/fail | any `$` or `%` token not present in extraction |
| `verify` | script.md + **source PDF text** (independent of extraction) | `verification.json`: every fact and amount in the script traced to a page/line on the uploaded return, or flagged | any amount or fact not found on the return; any required fact contradicted by the return |
| `tts` | script.md | per-sentence WAV + durations | — |
| `slides` | extraction.json + branding | PNG per slide | — |
| `mux` | PNGs + WAVs + durations | `recap.mp4`, `recap.vtt`, `recap.txt` | — |
| `ready` | — | status = `needs_review` | — |

`validate` and `verify` are deliberately separate. `validate` proves the script only uses numbers the extractor produced. `verify` proves those numbers (and the facts around them) actually appear on the uploaded return, by searching the PDF's own text — so an extraction bug that produces a wrong-but-internally-consistent JSON is still caught. See §5a.

Jobs are independent. A batch is a grouping for the UI and for bulk actions only; the worker never sees batches. Concurrency is a setting (default 1); on the M6 keep it at 1.

Job states: `queued → processing → needs_review → approved → released → purged`, plus `failed` (with step + reason) and `rejected` (preparer sent it back; edits script and re-renders from `tts`).

## 5. Extraction schema (v1, 1040)

```json
{
  "meta": { "software": "ultratax", "tax_year": 2025, "form": "1040", "filing_status": "MFJ", "state_returns": ["MO"] },
  "taxpayer": { "first_name": "…", "last_name": "…", "spouse_first_name": "…" },
  "income": { "wages": 0, "interest": 0, "dividends": 0, "ira_pensions": 0, "social_security_taxable": 0, "capital_gain": 0, "schedule_1_total": 0, "total_income": 0 },
  "adjustments": { "schedule_1_adjustments": 0, "agi": 0 },
  "deductions": { "type": "standard|itemized", "amount": 0, "qbi": 0, "taxable_income": 0 },
  "tax": { "tax": 0, "schedule_2_total": 0, "nonrefundable_credits": 0, "other_taxes": 0, "total_tax": 0, "effective_rate": 0.0 },
  "payments": { "withholding": 0, "estimates": 0, "refundable_credits": 0, "total_payments": 0 },
  "result": { "refund": 0, "amount_owed": 0, "applied_to_next_year": 0 },
  "state": [ { "code": "MO", "taxable_income": 0, "tax": 0, "payments": 0, "refund": 0, "amount_owed": 0 } ],
  "prior_year": { "present": false, "agi": 0, "total_tax": 0, "refund": 0, "amount_owed": 0 },
  "observations": [ { "id": "yoy_agi", "delta": 0, "pct": 0.0 } ],
  "recon": { "passed": true, "checks": [ { "name": "total_income_foots", "expected": 0, "actual": 0, "ok": true } ] }
}
```

Only fields present here may be referenced by the script template. Names are used in the greeting only and are never spoken in full with an SSN or address.

## 5a. Script-to-return verification

Runs after `validate`, before any audio is generated, and again on every manual script save. Produces `verification.json`, shown to the preparer as a checklist on the job page. A job cannot reach `needs_review` with any failed item; the preparer cannot Approve while any item is `flagged`.

**What is checked, and against what**

| Item | Checked against | Method |
|---|---|---|
| Every dollar amount in the script | Source PDF text (all pages), not extraction.json | Normalize (`$1,234` / `1,234` / `1234` / `(1,234)`), search page text; record page + the label text on the same y-band (e.g. "Line 11 Adjusted gross income"). Must be found on the page the form profile expects for that line, or anywhere with a matching label. |
| Every percentage | Recomputed from amounts found on the return | Effective rate = total_tax / taxable_income (and AGI variant); YoY % from prior-year amounts found on the return or prior-year PDF. Must match within 0.1 pt. |
| Every YoY delta | Prior-year amounts on the return's comparison page or the prior-year PDF | Recomputed; must match within $1. If no prior-year source exists, any YoY sentence is a failure. |
| Tax year | Return header | Must appear in the script exactly once and match. |
| Filing status | Form 1040 checkbox / header text | Script's status phrase ("married filing jointly") must map to the status printed on the return. |
| Taxpayer first name(s) | Form 1040 name line | Greeting names must match; spouse name only if MFJ/MFS on the return. |
| Refund vs. balance due direction | Line 34/35a vs 37 | Script must say "refund" only if the return shows a refund, "owe/balance due" only if it shows an amount owed. Sign errors are the most damaging failure; this is a hard check. |
| State names and results | State return header + result lines | Each state mentioned must exist in the package; each state amount traced as above. |
| Deduction type | Schedule A presence / line 12 | "standard" vs "itemized" must match. |
| Absence checks | Whole script | No SSN pattern, no EIN, no bank/routing digits, no street address, no dollar figure that appears on the return but is a bank account or routing number. |
| Coverage | extraction.json required fields | The script must mention total income, total tax, and the result; a script that omits the result is failed. |

**Output** — `verification.json`:

```json
{ "passed": true,
  "items": [
    { "kind": "amount", "text": "$84,250", "status": "verified", "page": 1, "label": "Line 11 Adjusted gross income", "slide": "income" },
    { "kind": "direction", "text": "refund", "status": "verified", "page": 2, "label": "Line 35a Refund" },
    { "kind": "amount", "text": "$3,100", "status": "flagged", "reason": "not found on any page", "slide": "observations" }
  ],
  "source_sha256": "…", "script_sha256": "…" }
```

**UI** — on the job page, a "Verification" panel lists every item with a ✓/✗, and clicking an item opens the source PDF at that page with the matched text highlighted. Approve is disabled until every item is ✓. The approve action stores `verification.json` alongside the script and extraction snapshot so the audit trail shows exactly what was checked when the preparer signed off.

**Independence rule** — `verify` may not import from `extract`. It reads the raw PDF with its own text pass. Shared code is limited to the number-normalization helper, which has its own tests.

## 6. Users and roles

| Role | Can |
|---|---|
| `admin` | Everything: users, settings, retention policy, branding, email, audit log, purge now (all due, one client, or one job) |
| `preparer` | Upload, view, edit script, approve, release, download, delete own uploads within retention |
| `staff` | Upload, view status, view video after approval, download after release |
| `viewer` | View released videos only (e.g., front-desk or a reviewing partner who never uploads) |

First admin is created by `docker compose run api seed-admin` or through a one-time setup page when the users table is empty. Passwords: Argon2id, minimum 12 chars, breach-list check offline (top-100k list bundled). Sessions: 12 h idle, 7 d absolute. Optional passkeys. Optional TOTP. Admin can force-logout any user.

## 7. Retention

Settings (admin):
- **Source PDFs**: keep N days after upload (default 30; 0 = delete immediately after `ready`).
- **Extraction JSON + script**: keep N days after release (default 365).
- **Videos**: keep N days after release (default 90).
- **Failed jobs**: keep N days (default 7).
- **Audit log**: never purged by policy; export + truncate is a manual admin action.
- **Per-client override**: any client record can pin a longer or shorter window; "legal hold" flag suspends purge for that client.

Purge job: hourly; selects rows past their window; deletes the encrypted blob, shreds the per-file key, marks the row `purged` with timestamp and actor `system:retention`; writes an audit event. Admin "Purge now" runs the same code path with actor = user, at three scopes: everything due (Settings › Retention), one client (client page), or one job (job page, added 2026-09-11, QUESTIONS.md Q53). Every scope obeys legal hold and the thumbs-down hold, and a job still being processed is refused.

## 8. UI map

- `/setup` — first-run admin creation (only when no users exist)
- `/login`
- `/` — Dashboard: queue (processing / needs review / recent), quick upload
- `/upload` — drag-drop one or many PDFs, or a ZIP of PDFs. Each file becomes a row in a staging table: detected taxpayer name + tax year (from a fast first-page text pass), auto-matched client (exact / fuzzy / new), optional prior-year PDF pairing (auto-paired when a second PDF for the same name has tax_year − 1; else manual), optional notes. Preparer fixes any row, then "Queue N jobs". Rows with no confident client match require a manual pick before queueing.
- `/batches/:id` — Batch detail: progress bar, per-job status/step, failed jobs with reason and "Retry" (re-enqueue from the failed step), "Approve all verified" (approves every job in `needs_review` whose verification has zero flags — each approval still audited individually), "Download all released" as one ZIP of per-client ZIPs.
- `/jobs/:id` — Job detail: status timeline, extraction table (read-only; "Re-extract" button; recon checks with per-check downgrade-to-warning for preparers), script editor with validator + verification panel, video preview, approve / reject / release, download (MP4, VTT, TXT, extraction JSON)
- `/clients` — client list, per-client jobs, retention override, legal hold
- `/settings/general` — firm name, logo, colors, default voice, model name, concurrency, Ollama URL
- `/account` — every role: change password, and the narration voice used for the recaps this user uploads
- `/settings/retention` — the four windows + per-client defaults
- `/settings/users` — CRUD, roles, reset password, force logout, passkeys/TOTP status
- `/settings/audit` — searchable audit log, CSV export
- `/settings/email` — outgoing email (Emailit), sender, public URL, test send (Q48; replaced `/settings/license`, removed per Q49)
- `/settings/backup` — Duplicati link-out, export settings JSON, import settings JSON

## 9. Security posture summary (for the firm's WISP)

Data at rest encrypted (age, per-file keys). Data in transit TLS via Caddy. No third-party AI processing; worker cannot reach the internet. RBAC with audit trail on upload, view, approve, release, download, delete, recon-exception, purge, login, settings change. Retention enforced automatically. Backups optional and firm-controlled. Aligns with IRS Pub 4557 checklist items for access control, encryption, and data disposal.

## 10. Out of scope for v1

Business returns; client portal or share links; Vibe Connect / T&B or any other integration; e-signature; multi-firm tenancy; email to clients (the app never emails clients; preparers download and send the file themselves; since 2026-09-05 it does email firm users invites and password-reset links through Emailit, QUESTIONS.md Q48); avatar or generative video; mobile app.
