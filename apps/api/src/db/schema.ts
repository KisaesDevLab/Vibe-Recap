import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  uniqueIndex,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["viewer", "staff", "preparer", "admin"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  disabled: boolean("disabled").notNull().default(false),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  totpSecret: text("totp_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_at_idx").on(t.at),
    index("audit_action_idx").on(t.action),
    index("audit_target_idx").on(t.targetType, t.targetId),
    index("audit_actor_idx").on(t.actorId),
  ],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Phase 2: clients, batches, jobs, files, job_events
// ---------------------------------------------------------------------------

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "processing",
  "needs_review",
  "approved",
  "released",
  "purged",
  "failed",
  "rejected",
]);

export const fileKindEnum = pgEnum("file_kind", [
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
]);

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    externalRef: text("external_ref"),
    retentionSourceDays: integer("retention_source_days"),
    retentionExtractionDays: integer("retention_extraction_days"),
    retentionVideoDays: integer("retention_video_days"),
    legalHold: boolean("legal_hold").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("clients_normalized_idx").on(t.normalizedName)],
);

export const batches = pgTable("batches", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  fileCount: integer("file_count").notNull().default(0),
  note: text("note"),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    status: jobStatusEnum("status").notNull().default("queued"),
    step: text("step"),
    resumeFrom: text("resume_from"),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    batchId: uuid("batch_id").references(() => batches.id),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    taxYear: integer("tax_year"),
    software: text("software"),
    form: text("form").notNull().default("1040"),
    sourceSha256: text("source_sha256").notNull(),
    priorSha256: text("prior_sha256"),
    note: text("note"),
    pageCount: integer("page_count"),
    textCoverage: integer("text_coverage"),
    errorStep: text("error_step"),
    errorMessage: text("error_message"),
    reconExceptions: jsonb("recon_exceptions").$type<ReconException[]>().notNull().default([]),
    extractionSha256: text("extraction_sha256"),
    scriptSha256: text("script_sha256"),
    verificationSha256: text("verification_sha256"),
    approvedBy: uuid("approved_by"),
    approvedScriptSha256: text("approved_script_sha256"),
    approvedExtractionSha256: text("approved_extraction_sha256"),
    approvedVerificationSha256: text("approved_verification_sha256"),
    releasedBy: uuid("released_by"),
    rejectedReason: text("rejected_reason"),
    delivered: boolean("delivered").notNull().default(false),
    deliveredNote: text("delivered_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    processingAt: timestamp("processing_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_status_idx").on(t.status),
    index("jobs_client_idx").on(t.clientId),
    index("jobs_batch_idx").on(t.batchId),
    index("jobs_created_idx").on(t.createdAt),
  ],
);

export interface ReconException {
  check: string;
  reason: string;
  by: string;
  at: string;
}

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: fileKindEnum("kind").notNull(),
    path: text("path").notNull(),
    keyPath: text("key_path").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    seq: integer("seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (t) => [index("files_job_idx").on(t.jobId), index("files_kind_idx").on(t.kind)],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    step: text("step"),
    status: text("status").notNull(),
    message: text("message"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("job_events_job_idx").on(t.jobId)],
);

export type Client = typeof clients.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type JobEvent = typeof jobEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Revision requests: a per-job thread of change instructions for the script.
// Each message becomes one regenerate-with-instructions pass through the same
// validate -> verify -> render gates. Nothing here bypasses them.
// ---------------------------------------------------------------------------

export const jobRevisions = pgTable(
  "job_revisions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    requestedByLabel: text("requested_by_label").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("pending"), // pending | applied | rejected
    previousStatus: text("previous_status").notNull(),
    scriptSha256Before: text("script_sha256_before"),
    scriptSha256After: text("script_sha256_after"),
    attempts: jsonb("attempts").$type<unknown[]>().notNull().default([]),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("job_revisions_job_idx").on(t.jobId)],
);

export type JobRevision = typeof jobRevisions.$inferSelect;

/**
 * Preparer feedback on a finished recap: one row per user per job, updated in place. A thumbs-down
 * puts the job's files on hold past the retention windows (hold_until, 90 days) so the failure can
 * be studied; an admin dismisses the feedback to release the hold early. Never purged.
 */
export const jobFeedback = pgTable(
  "job_feedback",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    userLabel: text("user_label").notNull(),
    verdict: text("verdict").notNull(), // up | down
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    note: text("note"),
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedBy: uuid("dismissed_by"),
    dismissedByLabel: text("dismissed_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_feedback_job_idx").on(t.jobId), uniqueIndex("job_feedback_job_user_uq").on(t.jobId, t.userId), index("job_feedback_hold_idx").on(t.holdUntil)],
);

export type JobFeedback = typeof jobFeedback.$inferSelect;
