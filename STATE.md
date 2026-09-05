# STATE.md — Vibe Recap build status

Updated by Claude Code at the end of each phase. Read after CLAUDE.md, docs/PLAN.md, docs/PHASES.md.

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 1 Skeleton, compose, auth, first admin | done 2026-09-05 | images build; unit + integration tests green; compose smoke test on Windows dev box, not yet on the M6 |
| 2 Upload, storage, encryption, clients, jobs | done 2026-09-05 | age storage on both sides, staging via worker queue, batches/jobs/clients UI; tests green; stack smoke-tested locally |
| 3 Extraction, profiles, recon | done 2026-09-05 | 6/6 layouts match `.expected.json` exactly; recon gate, exceptions, re-extract, extraction panel; pipeline orchestrator with resume points |
| 4 OCR fallback | done 2026-09-05 | rasterize + Ollama OCR + invisible text-layer overlay; 90 s per-page cap; tested with a stand-in OCR engine, not yet against real GLM-OCR |
| 5 Script, validator, verifier | done 2026-09-05 | prompt + Ollama client + 3-attempt loop, Python validator with TS mirror, independent verifier (own PDF pass) with page/label evidence; golden scripts pass on all 6 layouts; script editor + verification panel |
| 6 Render, review, approval | done 2026-09-05 | Kokoro per-sentence narration, Jinja/Playwright slides, ffmpeg xfade mux, VTT/TXT; approve with three-hash snapshot, reject, re-render, bulk approve; whole-pipeline test produces an MP4. Passkeys/TOTP deferred (Q25) |
| 7 Release and download | done 2026-09-05 | release, role/state-gated downloads with one audit row each, package ZIP, batch release-all and download-all (ZIP of ZIPs), delivered checkbox, dashboard filters |
| 8 Retention and purge | done 2026-09-05 | hourly purge is the only deleter; time-travel tests at the window edge; legal hold; purge-now with dry-run preview; per-client purge with typed confirmation; orphan quarantine at startup; retention settings page + CSV report |
| 9 Users, audit UI, licensing, backup, docs | done 2026-09-05 | users CRUD with invites and last-admin protection, audit log UI + CSV, licensing with grace and read-only gate, general settings + Test Ollama, settings/profile export-import, GHCR workflow with SBOM, INSTALL.md final. Ship gate (a non-author CPA follows INSTALL.md on a fresh host) not yet exercised |

## Not yet verified (needs the M6 or real inputs)

- `docker compose up --build` on the reference box (Ubuntu 24.04). Everything so far ran on a
  Windows 11 dev box under Docker Desktop, where the stack came up, staged uploads through the real
  worker, extracted and reconciled fixtures, and rendered videos in tests.
- A real UltraTax return from the practice (Phase 3 success criterion). Only synthetic fixtures exist.
- GLM-OCR's real output format (Q19). OCR tests use a stand-in engine.
- The licensing server contract (Q31). Tests use a fake client.
- The ship gate: a CPA who is not the author following INSTALL.md on a fresh host.

## Verified end to end on the dev box (2026-09-05)

`scripts/smoke-e2e.py` with the Lacerte single/itemized fixture against the compose stack and the
real `qwen3:8b`: upload staged in 0.3 s, ingest through recon in 0.5 s, script accepted on the
second attempt (2 m 40 s on this CPU), 23 verification items with 0 flagged, narration 38 s,
slides 1.5 s, mux 18 s; a 122.7 s 1920x1080 H.264/AAC video reached `needs_review` 3 m 40 s
after upload. Approve, release, and the package ZIP download then worked through the API.
A second run after the router and appliance changes (CCH head-of-household fixture with Kansas
and Missouri returns, local Ollama fallback since no router token): script accepted on the
second attempt, 32 verification items with 0 flagged, 130.8 s video, `needs_review` in 4 minutes.
Earlier runs on the same box surfaced and fixed: the 180 s model timeout (now 600 s), scripts
under 250 words (prompt now states the target), an allowed observation delta being called the
total tax (verifier now feeds back into the retry loop), and the "tax year exactly once" rule
(relaxed, Q36). Screenshots in `docs/screenshots/` come from this run.

## Q&A outcomes and post-plan work (2026-09-05)

- Vibe AI Router is the default script provider (Q37); bundled Ollama is the local option. The
  worker reaches the router only through a socat relay so it never joins a network with an
  internet route. `recap_script` is registered by the API at startup.
- Licensing is informational until the server exists (`LICENSE_ENFORCE=false`, Q35).
- Verified against the real Vibe-AI-Router dev server (0.0.27) on this box: admin login, app
  token mint, `POST /v1/task-classes/register` (created `recap_script`, `local_only`), and a
  completion that returned `policy_blocked` with Recap's operator message, which is the expected
  state until an admin binds a model to the class. A served completion needs a bound model
  (router console > Policies); not exercised here.
- Vibe Appliance packaging lives in `.appliance/` (Q38) and was applied to the Vibe-Appliance
  repo (manifest, overlay, env template, emergency port 5183, preflight list); its 34 manifest
  tests pass with Recap included. Not yet exercised on an appliance host.
- Real returns (Q43): two UltraTax 2025 client copies (one all-refund with zero total tax, one
  balance due with a penalty, both with Missouri) run end to end on the live dev stack with
  qwen3:8b: extraction reconciles, the scripts pass every verification item (34 and 38), and the
  videos render. Four verifier gaps found by those runs are fixed and covered by tests;
  `worker/tests/test_real_returns.py` re-checks any PDFs under `tests/fixtures/real/`. The other five vendor profiles remain
  validated on synthetic fixtures only; real samples are the next thing to ask for.
- Revision requests (Q40): `job_revisions` table, `POST /api/jobs/:id/revisions`, worker
  `revise()` in `script/generate.py`, `RevisionKept` restores the previous status on rejection,
  "Ask for changes" panel on the job page. Exercised live on 2026-09-05 with qwen3:8b: the
  revision applied in one attempt, re-verified (39 items, 0 flagged), re-narrated and re-muxed,
  and the job returned to needs_review with a new script hash.

## Deviations from the plan

- Phase 2: the "kill the worker mid-job, the rest continue" test is deferred to Phase 3 where the
  pipeline exists; Phase 2's pipeline stub marks every job failed at `ingest` by design.
- Phase 2: staging runs in the worker via a second queue (Q11) rather than in-process in the API.

## What the next phase should know

- Phase 3/4: `worker/recap/pipeline.py` is the orchestrator; steps live in `STEP_FUNCS` and later
  phases fill in `script/generate.py`, `verify/verify.py`, `render/{tts,slides,mux}.py` (imported
  lazily by the step functions). `replace_file()` is how a step stores an artifact. Form profiles
  extend `form-profiles/_base-1040.yaml`; regexes must be single-quoted in YAML. The generic profile
  is used for unknown software. `ctx.extraction` is the dict the script prompt and validator read.
- Phase 5: `worker/recap/validate.py` and `packages/shared/src/script.ts` must stay in step (same
  regexes, same 0.1-point percent tolerance). Golden scripts live in `tests/fixtures/scripts/` and
  double as the stub model's output in pipeline tests (`_client_for` is monkeypatched). The verifier
  reads only `recap.numbers`; `test_verify.py` greps its imports. Verification items carry
  `page` + `label`; the UI links to `/api/jobs/:id/source.pdf#page=N`.
- Phase 6: render steps are `render/tts.py` (Kokoro, per-sentence WAVs grouped per slide),
  `render/slides.py` (Jinja `templates/slides.html` -> Playwright PNG), `render/mux.py` (xfade +
  concat audio). Tests inject `fake_synth` and monkeypatch `tts.kokoro_synth`. On Windows the
  winget ffmpeg lives under `AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_*` and must be on
  PATH for the mux tests; they skip otherwise. `approvalCheck()` in `routes/review.ts` is the single
  source of approval rules; bulk approve calls it per job.
- Phase 9: the license gate is a preHandler in `app.ts` that reads the shared `app.licenseState`
  object (mutate it with `Object.assign`, never reassign: route contexts are encapsulated).
  `enforceLicense` is on only in production; tests pass a fake `LicenseClient`. Settings values are
  written as jsonb (`'null'::jsonb` for null). Form profiles are read from `DATA_DIR/form-profiles`.

- Phase 1: `npm run test:services` starts a throwaway Postgres (55432) and Redis (56379) that the
  API integration tests use; they skip with a warning when those are unreachable. The worker venv
  lives at `worker/.venv` (gitignored). Login CSRF uses a per-session token returned by
  `/api/auth/me` and sent as `x-csrf-token`. Routes under `/api` require a session unless they set
  `config: { auth: false }`.
- Phase 2: `Storage` (Node) and `recap.storage.Storage` (Python) share the on-disk layout
  `blobs/<scope>/<id>.age` + `.key`; the API creates `keys/master.key` on first start and the worker
  waits for it. `FakeStager` in `apps/api/test/helpers.ts` stands in for the worker in API tests.
  Re-entry uses `jobs.resume_from`; `requeue()` in `routes/jobs.ts` is the one place that re-enqueues.
  The test databases run under compose project `recap-test` so the main stack never removes them.
