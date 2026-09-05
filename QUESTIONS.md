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
| Q16 | What happens after "Re-extract" (identify through recon) succeeds on a job that already had a script and video? | The pipeline continues through script, validate, verify and render, because the old script's extraction hash no longer matches and Approve would refuse it anyway. Re-extract therefore means "re-run everything from identify". | 3 |
| Q17 | Filing-status checkbox detection relies on an "X"/"[X]" token near the status phrase, or on the status being the only one printed. Real layouts draw the box as a glyph or a vector. | Calibrate against real returns from each package; the profile's `filing_status` phrases are data, the marker heuristic is in `mapper.detect_filing_status`. If a package prints nothing detectable, the job fails at extract with "filing status not detected" rather than guessing. | 3 |
| Q18 | Line 4b (IRA) and 5b (pensions) are one schema field `ira_pensions`. | Summed via `combine: sum` in the profile so the schema in PLAN.md §5 stays unchanged. | 3 |
| Q19 | The OCR model is asked for line-level JSON with pixel boxes. GLM-OCR's real output format may differ. | `ocr.parse_ocr_json` is the only place that reads it; adjust the prompt or parser after a real run on the M6. Tests use a stand-in OCR so the overlay and re-extraction path is covered regardless. | 4 |
| Q20 | The verifier must show the matched text highlighted in the PDF viewer. Browser PDF viewers differ: Chrome honours `#page=N`, Firefox (pdf.js) also honours `#search=`. | Links open `/api/jobs/:id/source.pdf#page=N&search=<amount>`; the page is always right, the highlight depends on the browser. A bundled pdf.js viewer would make it uniform (v1.1). | 5 |
| Q21 | Which computed percentages may a script state? | Effective rate (total tax / taxable income), year-over-year AGI and total-tax changes, and withholding as a share of total tax. The validator whitelists them from the observations; the verifier recomputes each from the return's own lines and also accepts tax / AGI. Anything else is flagged. | 5 |
| Q22 | Manual script edits are validated twice: the API applies the TypeScript mirror on save and the worker applies the Python validator before verify. | Keep both; the API check gives instant feedback and the worker check is the gate. If the two ever disagree the worker wins and the job fails at `validate` with the reason shown on the job page. | 5 |

