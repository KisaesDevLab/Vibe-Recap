import { randomBytes } from "node:crypto";
import { and, eq, ne, or, lte } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { sessions, users, type Session, type User } from "../db/schema.js";

export const SESSION_COOKIE = "recap_sid";

export interface SessionPolicy {
  idleHours: number;
  absoluteDays: number;
}

export interface SessionWithUser {
  session: Session;
  user: User;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function createSession(
  db: Db,
  userId: string,
  policy: SessionPolicy,
  meta: { ip?: string; userAgent?: string },
  now = new Date(),
): Promise<Session> {
  const id = newToken(32);
  const expiresAt = new Date(now.getTime() + policy.absoluteDays * 24 * 3600 * 1000);
  const [row] = await db
    .insert(sessions)
    .values({
      id,
      userId,
      csrfToken: newToken(24),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .returning();
  return row!;
}

/** True when the session is past its idle or absolute window. */
export function isExpired(session: Session, policy: SessionPolicy, now = new Date()): boolean {
  if (session.expiresAt.getTime() <= now.getTime()) return true;
  const idleMs = policy.idleHours * 3600 * 1000;
  return session.lastSeenAt.getTime() + idleMs <= now.getTime();
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export async function loadSession(
  db: Db,
  id: string,
  policy: SessionPolicy,
  now = new Date(),
): Promise<SessionWithUser | null> {
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (isExpired(row.session, policy, now) || row.user.disabled) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
    row.session.lastSeenAt = now;
  }
  return row;
}

export async function destroySession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function destroyUserSessions(db: Db, userId: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  return rows.length;
}

export async function destroyOtherSessions(db: Db, userId: string, keepId: string): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepId)))
    .returning({ id: sessions.id });
  return rows.length;
}

/** Remove sessions past their absolute window or idle longer than policy allows. */
export async function sweepSessions(db: Db, policy: SessionPolicy, now = new Date()): Promise<number> {
  const idleCutoff = new Date(now.getTime() - policy.idleHours * 3600 * 1000);
  const rows = await db
    .delete(sessions)
    .where(or(lte(sessions.expiresAt, now), lte(sessions.lastSeenAt, idleCutoff)))
    .returning({ id: sessions.id });
  return rows.length;
}
