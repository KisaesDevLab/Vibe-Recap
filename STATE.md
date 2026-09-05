# STATE.md — Vibe Recap build status

Updated by Claude Code at the end of each phase. Read after CLAUDE.md, docs/PLAN.md, docs/PHASES.md.

## Phase status

| Phase | Status | Notes |
|---|---|---|
| 1 Skeleton, compose, auth, first admin | done 2026-09-05 | images build; unit + integration tests green; compose smoke test on Windows dev box, not yet on the M6 |
| 2 Upload, storage, encryption, clients, jobs | done 2026-09-05 | age storage on both sides, staging via worker queue, batches/jobs/clients UI; tests green; stack smoke-tested locally |
| 3 Extraction, profiles, recon | done 2026-09-05 | 6/6 layouts match `.expected.json` exactly; recon gate, exceptions, re-extract, extraction panel; pipeline orchestrator with resume points |
| 4 OCR fallback | done 2026-09-05 | rasterize + Ollama OCR + invisible text-layer overlay; 90 s per-page cap; tested with a stand-in OCR engine, not yet against real GLM-OCR |
| 5 Script, validator, verifier | not started | |
| 6 Render, review, approval | not started | |
| 7 Release and download | not started | |
| 8 Retention and purge | not started | |
| 9 Users, audit UI, licensing, backup, docs | not started | |

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
