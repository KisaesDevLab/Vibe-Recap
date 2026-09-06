import type { Db } from "../db/index.js";
import { auditEvents } from "../db/schema.js";

export interface Actor {
  id: string | null;
  label: string;
}

export const SYSTEM_RETENTION: Actor = { id: null, label: "system:retention" };
export const SYSTEM_STARTUP: Actor = { id: null, label: "system:startup" };
export const SYSTEM_WORKER: Actor = { id: null, label: "system:worker" };
export const ANONYMOUS: Actor = { id: null, label: "anonymous" };

export interface AuditInput {
  actor: Actor;
  action: string;
  target?: { type: string; id: string } | null;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Write one audit row. Never put names, SSNs, or amounts in `meta`; use ids and hashes.
 * Bulk actions write one row per job with `bulk: true` in meta.
 */
export async function audit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: input.actor.id,
    actorLabel: input.actor.label,
    action: input.action,
    targetType: input.target?.type ?? null,
    targetId: input.target?.id ?? null,
    ip: input.ip ?? null,
    meta: input.meta ?? {},
  });
}
