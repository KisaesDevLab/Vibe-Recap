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
