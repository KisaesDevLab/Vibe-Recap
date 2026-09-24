/** Roles, in ascending privilege order. */
export const ROLES = ["viewer", "staff", "preparer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(min);
}

/** Job lifecycle. See docs/PLAN.md §4. */
export const JOB_STATUSES = [
  "queued",
  "processing",
  "needs_review",
  "approved",
  "released",
  "purged",
  "failed",
  "rejected",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Worker steps, in pipeline order. `ocr` is conditional. */
export const JOB_STEPS = [
  "ingest",
  "identify",
  "extract",
  "ocr",
  "recon",
  "script",
  "validate",
  "verify",
  "tts",
  "slides",
  "mux",
  "ready",
] as const;
export type JobStep = (typeof JOB_STEPS)[number];

/** Kinds of encrypted blobs attached to a job. */
export const FILE_KINDS = [
  "source",
  "prior",
  "extraction",
  "script",
  "verification",
  "audio",
  "slide",
  "video",
  "vtt",
  "txt",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const SOFTWARE = ["ultratax", "lacerte", "cch", "gosystem", "drake", "proseries", "unknown"] as const;
export type Software = (typeof SOFTWARE)[number];

export const TLS_MODES = ["lan", "tailscale", "domain"] as const;

/**
 * Tax software the product accepts at upload. v1 is validated on UltraTax CS client copies only
 * (QUESTIONS.md Q45); the other profiles exist but are unproven, so their packages are skipped at
 * staging. A scanned package with no text layer cannot name its software and is let through for OCR.
 */
export const ACCEPTED_SOFTWARE = ["ultratax"] as const;

/** Preparer feedback on a finished recap. A thumbs-down carries one or more of these reasons. */
export const FEEDBACK_REASONS = [
  { code: "wrong_number", label: "A number is wrong or missing" },
  { code: "wrong_direction", label: "Refund or balance due stated the wrong way" },
  { code: "state_wrong", label: "State return missing or wrong" },
  { code: "prior_year_wrong", label: "Prior-year comparison wrong" },
  { code: "extraction_failed", label: "Extraction or reconciliation failed" },
  { code: "wording", label: "Wording is confusing or inaccurate" },
  { code: "tone", label: "Tone not right for this client" },
  { code: "length", label: "Too long or too short" },
  { code: "audio", label: "Narration audio problem" },
  { code: "slides", label: "Slide layout or content problem" },
  { code: "video", label: "Video would not play or render" },
  { code: "other", label: "Something else (say what in the note)" },
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]["code"];
export const FEEDBACK_REASON_CODES = FEEDBACK_REASONS.map((r) => r.code) as FeedbackReason[];

/** How long a thumbs-down keeps a job's files past the retention windows, unless an admin dismisses it. */
export const FEEDBACK_HOLD_DAYS = 90;

export const SOFTWARE_LABELS: Record<string, string> = {
  ultratax: "UltraTax CS",
  lacerte: "Lacerte",
  cch: "CCH Axcess",
  gosystem: "GoSystem Tax RS",
  drake: "Drake",
  proseries: "ProSeries",
  unknown: "unknown software",
};

/** Kokoro narration voices, all of them inside the `voices-v1.0.bin` already in the worker image.
 * The letter is Kokoro's own published quality grade (hexgrad/Kokoro-82M VOICES.md): af_heart and
 * af_bella are the only A-grade voices, and am_adam is kept only because installs already set it.
 * The firm sets a default, each user may pick their own under Your account, and a single job can be
 * re-rendered in another voice from the job page. Keep in step with worker/recap/render/tts.py. */
export const VOICES = {
  af_heart: "Heart — American female (A)",
  af_bella: "Bella — American female (A-)",
  af_nicole: "Nicole — American female (B-)",
  af_aoede: "Aoede — American female (C+)",
  af_kore: "Kore — American female (C+)",
  af_sarah: "Sarah — American female (C+)",
  af_nova: "Nova — American female (C)",
  af_alloy: "Alloy — American female (C)",
  am_michael: "Michael — American male (C+)",
  am_fenrir: "Fenrir — American male (C+)",
  am_puck: "Puck — American male (C+)",
  am_adam: "Adam — American male (F+)",
  bf_emma: "Emma — British female (B-)",
  bf_isabella: "Isabella — British female (C)",
  bm_george: "George — British male (C)",
  bm_fable: "Fable — British male (C)",
} as const;
export type Voice = keyof typeof VOICES;
export const VOICE_CODES = Object.keys(VOICES) as Voice[];
export const DEFAULT_VOICE: Voice = "af_heart";

/**
 * Extracted figures a preparer may override when the profile misread a line (Q66). Paths match
 * extraction.json; the worker's list is `worker/recap/extract/overrides.py` and must stay in step.
 * State figures are `state.<CODE>.<field>` with the fields in OVERRIDE_STATE_FIELDS.
 */
export const OVERRIDE_FIELDS = [
  { path: "income.wages", label: "Wages", line: "1z" },
  { path: "income.interest", label: "Taxable interest", line: "2b" },
  { path: "income.dividends", label: "Ordinary dividends", line: "3b" },
  { path: "income.ira_pensions", label: "IRA distributions and pensions (taxable)", line: "4b + 5b" },
  { path: "income.social_security_taxable", label: "Social security (taxable)", line: "6b" },
  { path: "income.capital_gain", label: "Capital gain or loss", line: "7a" },
  { path: "income.schedule_1_total", label: "Schedule 1 additional income", line: "8" },
  { path: "income.total_income", label: "Total income", line: "9" },
  { path: "adjustments.schedule_1_adjustments", label: "Schedule 1 adjustments", line: "10" },
  { path: "adjustments.agi", label: "Adjusted gross income", line: "11a" },
  { path: "deductions.amount", label: "Standard or itemized deduction", line: "12e" },
  { path: "deductions.qbi", label: "QBI deduction", line: "13a" },
  { path: "deductions.additional", label: "Schedule 1-A deductions", line: "13b" },
  { path: "deductions.taxable_income", label: "Taxable income", line: "15" },
  { path: "tax.tax", label: "Tax", line: "16" },
  { path: "tax.schedule_2_total", label: "Schedule 2 additional tax", line: "17" },
  { path: "tax.nonrefundable_credits", label: "Nonrefundable credits", line: "21" },
  { path: "tax.other_taxes", label: "Other taxes", line: "23" },
  { path: "tax.total_tax", label: "Total tax", line: "24" },
  { path: "payments.withholding", label: "Withholding", line: "25d" },
  { path: "payments.estimates", label: "Estimated payments", line: "26" },
  { path: "payments.refundable_credits", label: "Refundable credits", line: "32" },
  { path: "payments.total_payments", label: "Total payments", line: "33" },
  { path: "result.refund", label: "Refund", line: "35a" },
  { path: "result.applied_to_next_year", label: "Applied to next year", line: "36" },
  { path: "result.amount_owed", label: "Amount owed", line: "37" },
  { path: "extras.estimated_tax_penalty", label: "Estimated tax penalty", line: "38" },
  { path: "prior_year.agi", label: "Prior year AGI", line: "comparison" },
  { path: "prior_year.total_tax", label: "Prior year total tax", line: "comparison" },
  { path: "prior_year.refund", label: "Prior year refund", line: "comparison" },
  { path: "prior_year.amount_owed", label: "Prior year amount owed", line: "comparison" },
] as const;
export const OVERRIDE_STATE_FIELDS = [
  { field: "taxable_income", label: "taxable income" },
  { field: "tax", label: "tax" },
  { field: "payments", label: "payments" },
  { field: "refund", label: "refund" },
  { field: "amount_owed", label: "amount owed" },
  { field: "penalty", label: "penalty" },
] as const;

const STATE_OVERRIDE_RE = new RegExp(`^state\.([A-Z]{2})\.(${OVERRIDE_STATE_FIELDS.map((f) => f.field).join("|")})$`);

export function isOverridePath(path: string): boolean {
  return OVERRIDE_FIELDS.some((f) => f.path === path) || STATE_OVERRIDE_RE.test(path);
}

/** Human label for an override path, e.g. "Refund (line 35a)" or "MO refund". */
export function overridePathLabel(path: string): string {
  const f = OVERRIDE_FIELDS.find((x) => x.path === path);
  if (f) return f.line === "comparison" ? f.label : `${f.label} (line ${f.line})`;
  const m = STATE_OVERRIDE_RE.exec(path);
  if (m) return `${m[1]} ${OVERRIDE_STATE_FIELDS.find((x) => x.field === m[2])?.label ?? m[2]}`;
  return path;
}
