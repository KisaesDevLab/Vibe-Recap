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
