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
