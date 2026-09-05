# QUESTIONS.md — open decisions

Each entry: the question, the recommended answer, and what was done. Decisions here were taken
to keep building; they are not locked and can be reversed. Locked decisions live in docs/PLAN.md §2.

| # | Question | Recommendation (taken) | Phase |
|---|---|---|---|
| Q11 | The staging pass (first-page names/year/software) must run in Python (pdfplumber) but the upload endpoint is Node. | Run it through a second BullMQ queue `recap-stage` serviced by the same worker container at concurrency 4, with the API awaiting the result (20 s timeout). Keeps one PDF parser and keeps the worker offline. Payload is `{stageId, fileId}`, ids only. | 2 |
| Q12 | Client display-name format for auto-created clients. | `Last, First` and `Last, First & Spouse` for joint returns; fuzzy matching also tries `Last, First` alone so a formerly single filer still matches. | 2 |
| Q13 | Where do uploaded bytes live before the preparer clicks Queue? | Encrypted immediately under `blobs/staging/<stageId>/` with the same per-file age keys; metadata in Redis with a 1 h TTL; a 10-minute cron removes staging directories whose Redis row expired. | 2 |
| Q14 | Original filenames may contain client names. | Kept only in the Redis staging row (1 h) for the preparer to recognise files; never written to Postgres or logs. | 2 |
| Q15 | Software signatures in `form-profiles/signatures.yaml` are best guesses ("UltraTax CS", "Lacerte", "CCH Axcess", "GoSystem", "Drake Software", "ProSeries"). | Confirm against real footers from each package; the file is data, no code change needed. | 2 |

