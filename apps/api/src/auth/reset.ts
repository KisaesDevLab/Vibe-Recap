/**
 * Password-reset tokens. Like invites they live in Redis, not Postgres: single use, short TTL,
 * and only the SHA-256 of the token is stored, so a Redis dump cannot be replayed. One live token
 * per user: requesting a new one revokes the previous one.
 */
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { newToken } from "./session.js";

export const RESET_TTL_S = 60 * 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const tokenKey = (hash: string) => `pwreset:${hash}`;
const userKey = (userId: string) => `pwreset:user:${userId}`;

export async function createResetToken(redis: Redis, userId: string, ttlS = RESET_TTL_S): Promise<string> {
  const previous = await redis.get(userKey(userId));
  if (previous) await redis.del(tokenKey(previous));
  const token = newToken(32);
  const hash = hashToken(token);
  await redis.set(tokenKey(hash), JSON.stringify({ userId }), "EX", ttlS);
  await redis.set(userKey(userId), hash, "EX", ttlS);
  return token;
}

export async function peekResetToken(redis: Redis, token: string): Promise<{ userId: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const raw = await redis.get(tokenKey(hashToken(token)));
  return raw ? (JSON.parse(raw) as { userId: string }) : null;
}

/** Atomically take the token out of Redis; a second caller gets null. */
export async function consumeResetToken(redis: Redis, token: string): Promise<{ userId: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const hash = hashToken(token);
  const raw = await redis.getdel(tokenKey(hash));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { userId: string };
  await redis.del(userKey(parsed.userId));
  return parsed;
}

export async function revokeResetTokens(redis: Redis, userId: string): Promise<void> {
  const hash = await redis.getdel(userKey(userId));
  if (hash) await redis.del(tokenKey(hash));
}
