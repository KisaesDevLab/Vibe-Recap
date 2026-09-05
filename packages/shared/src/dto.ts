import type { Role } from "./enums.js";

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface MeResponse {
  user: UserDto;
  csrfToken: string;
}

export interface SetupStatus {
  needed: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
}

export type ReadyState = "ok" | "degraded" | "failed";

export interface ReadyResponse {
  status: ReadyState;
  checks: { postgres: boolean; redis: boolean; ollama: boolean };
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Phase 2: clients, staging, batches, jobs
// ---------------------------------------------------------------------------
import type { FileKind, JobStatus, JobStep } from "./enums.js";

export interface ClientDto {
  id: string;
  name: string;
  externalRef: string | null;
  retentionSourceDays: number | null;
  retentionExtractionDays: number | null;
  retentionVideoDays: number | null;
  legalHold: boolean;
  notes: string | null;
  createdAt: string;
  jobCount?: number;
}

export interface DetectedInfo {
  firstName: string | null;
  lastName: string | null;
  spouseFirstName: string | null;
  taxYear: number | null;
  software: string | null;
  form: string | null;
  pageCount: number | null;
}

export interface ClientMatch {
  type: "exact" | "suggested" | "new";
  clientId?: string;
  clientName?: string;
  score?: number;
}

export interface StagedFileDto {
  fileId: string;
  originalName: string;
  sha256: string;
  size: number;
  status: "ok" | "skipped";
  skipReason?: string;
  role: "source" | "prior";
  detected: DetectedInfo | null;
  match: ClientMatch | null;
  clientId: string | null;
  newClientName: string | null;
  taxYear: number | null;
  priorFileId: string | null;
  note: string | null;
  include: boolean;
  warnings: string[];
}

export interface StageDto {
  id: string;
  createdAt: string;
  expiresAt: string;
  files: StagedFileDto[];
}

export interface StagedFilePatch {
  clientId?: string | null;
  newClientName?: string | null;
  taxYear?: number | null;
  priorFileId?: string | null;
  note?: string | null;
  include?: boolean;
}

export interface JobSummaryDto {
  id: string;
  status: JobStatus;
  step: JobStep | string | null;
  clientId: string;
  clientName: string;
  batchId: string | null;
  taxYear: number | null;
  software: string | null;
  errorStep: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  approvedAt: string | null;
  releasedAt: string | null;
  hasPrior: boolean;
  verificationFlags?: number;
  reconExceptionCount?: number;
}

export interface FileDto {
  id: string;
  kind: FileKind;
  sha256: string;
  size: number;
  seq: number;
  createdAt: string;
  purgedAt: string | null;
}

export interface JobEventDto {
  id: number;
  at: string;
  step: string | null;
  status: string;
  message: string | null;
  meta: Record<string, unknown>;
}

export interface JobDetailDto extends JobSummaryDto {
  note: string | null;
  uploadedBy: string;
  pageCount: number | null;
  files: FileDto[];
  events: JobEventDto[];
  rejectedReason: string | null;
  delivered: boolean;
  deliveredNote: string | null;
}

export interface BatchDto {
  id: string;
  createdAt: string;
  uploadedBy: string;
  fileCount: number;
  note: string | null;
  counts: Record<string, number>;
  jobs?: JobSummaryDto[];
}

export interface DashboardDto {
  processing: JobSummaryDto[];
  needsReview: JobSummaryDto[];
  recent: JobSummaryDto[];
  activeBatches: BatchDto[];
  counts: Record<string, number>;
  queue: { waiting: number; active: number; failed: number };
}

// ---------------------------------------------------------------------------
// Phase 3: extraction and reconciliation
// ---------------------------------------------------------------------------

export interface ReconCheckDto {
  name: string;
  expected: number;
  actual: number;
  ok: boolean;
  warning?: boolean;
}

export interface ObservationDto {
  id: string;
  delta: number;
  pct: number;
}

export interface StateResultDto {
  code: string;
  taxable_income: number;
  tax: number;
  payments: number;
  refund: number;
  amount_owed: number;
}

/** Mirrors docs/PLAN.md §5. Produced by the worker, never edited by hand. */
export interface ExtractionDto {
  meta: { software: string; tax_year: number; form: string; filing_status: string; state_returns: string[]; profile?: string };
  taxpayer: { first_name: string | null; last_name: string | null; spouse_first_name: string | null };
  income: { wages: number; interest: number; dividends: number; ira_pensions: number; social_security_taxable: number; capital_gain: number; schedule_1_total: number; total_income: number };
  adjustments: { schedule_1_adjustments: number; agi: number };
  deductions: { type: "standard" | "itemized"; amount: number; qbi: number; taxable_income: number };
  tax: { tax: number; schedule_2_total: number; nonrefundable_credits: number; other_taxes: number; total_tax: number; effective_rate: number };
  payments: { withholding: number; estimates: number; refundable_credits: number; total_payments: number };
  result: { refund: number; amount_owed: number; applied_to_next_year: number };
  state: StateResultDto[];
  prior_year: { present: boolean; agi: number; total_tax: number; refund: number; amount_owed: number; source?: string };
  observations: ObservationDto[];
  recon: { passed: boolean; checks: ReconCheckDto[] };
}

export interface ReconExceptionDto {
  check: string;
  reason: string;
  by: string;
  at: string;
}

export interface ExtractionResponse {
  extraction: ExtractionDto | null;
  sha256: string | null;
  reconExceptions: ReconExceptionDto[];
}

// ---------------------------------------------------------------------------
// Phase 5: script and verification
// ---------------------------------------------------------------------------

export interface ScriptResponse {
  script: string | null;
  sha256: string | null;
  extractionSha256: string | null;
  generatedFromExtraction: boolean;
}

export interface VerificationItemDto {
  kind: string;
  text: string;
  status: "verified" | "flagged";
  slide?: string;
  page?: number;
  label?: string;
  reason?: string;
}

export interface VerificationDto {
  passed: boolean;
  items: VerificationItemDto[];
  source_sha256: string;
  script_sha256: string;
}

export interface VerificationResponse {
  verification: VerificationDto | null;
  sha256: string | null;
  /** True when the stored verification was produced for a different script than the current one. */
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Revision requests (chat-style change instructions for the script)
// ---------------------------------------------------------------------------

export interface RevisionDto {
  id: string;
  message: string;
  status: "pending" | "applied" | "rejected";
  requestedBy: string;
  createdAt: string;
  resolvedAt: string | null;
  error: string | null;
  attempts: number;
  scriptSha256After: string | null;
}
