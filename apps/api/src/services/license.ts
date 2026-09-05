/**
 * Licensing against licensing.kisaes.com (the API container's only outbound destination).
 *
 * Contract (assumed; see QUESTIONS.md Q31):
 *   POST {LICENSE_SERVER_URL}/v1/validate
 *   { product: "vibe-recap", key, instance_id, seats_in_use, version }
 *   -> 200 { valid: boolean, expires_at?: ISO, max_seats?: number, message?: string }
 *
 * Daily check with a 14-day grace period when the server is unreachable. Without a valid
 * license after grace the app is read-only: state-changing API calls are refused with 402
 * except login/logout, setup, and the license settings themselves.
 */
import { createHash } from "node:crypto";
import { count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { licenses, users } from "../db/schema.js";
import { audit, SYSTEM_LICENSE } from "./audit.js";
import { getSetting, setSetting } from "./settings.js";

export const GRACE_DAYS = 14;

export type LicenseStatus = "valid" | "grace" | "invalid" | "unlicensed";

export interface LicenseState {
  status: LicenseStatus;
  readOnly: boolean;
  key: string | null;
  keyMasked: string | null;
  seats: number | null;
  seatsInUse: number;
  validUntil: string | null;
  lastCheckedAt: string | null;
  lastValidAt: string | null;
  message: string | null;
}

export interface LicenseClient {
  validate(input: { key: string; instanceId: string; seatsInUse: number; version: string }): Promise<{ valid: boolean; expires_at?: string; max_seats?: number; message?: string }>;
}

export class HttpLicenseClient implements LicenseClient {
  constructor(private readonly baseUrl: string) {}
  async validate(input: { key: string; instanceId: string; seatsInUse: number; version: string }) {
    const res = await fetch(new URL("/v1/validate", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ product: "vibe-recap", key: input.key, instance_id: input.instanceId, seats_in_use: input.seatsInUse, version: input.version }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return { valid: false, message: body.message ?? `license server answered ${res.status}` };
    }
    if (!res.ok) throw new Error(`license server ${res.status}`);
    return (await res.json()) as { valid: boolean; expires_at?: string; max_seats?: number; message?: string };
  }
}

export function maskKey(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Stable per-install id derived from the master public key, so the licensing server can count installs. */
export async function instanceId(app: FastifyInstance): Promise<string> {
  const { promises: fs } = await import("node:fs");
  try {
    const pub = await fs.readFile(app.storage.abs("keys/master.pub"), "utf8");
    return createHash("sha256").update(pub.trim()).digest("hex").slice(0, 32);
  } catch {
    return "unknown";
  }
}

export async function seatsInUse(app: FastifyInstance): Promise<number> {
  const [row] = await app.db.select({ n: count() }).from(users).where(eq(users.disabled, false));
  return row?.n ?? 0;
}

export async function currentState(app: FastifyInstance, now = new Date()): Promise<LicenseState> {
  const key = (await getSetting(app.db, "license_key")) || null;
  const [row] = await app.db.select().from(licenses).orderBy(desc(licenses.id)).limit(1);
  const inUse = await seatsInUse(app);
  const base: LicenseState = {
    status: "unlicensed",
    readOnly: true,
    key,
    keyMasked: maskKey(key),
    seats: row?.seats ?? null,
    seatsInUse: inUse,
    validUntil: row?.validUntil?.toISOString() ?? null,
    lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
    lastValidAt: row?.lastValidAt?.toISOString() ?? null,
    message: row?.message ?? null,
  };
  if (!key) return { ...base, message: "No license key entered" };
  if (!row || row.key !== key) return { ...base, status: "unlicensed", message: "License not yet checked" };
  const graceEnd = row.lastValidAt ? row.lastValidAt.getTime() + GRACE_DAYS * 86400_000 : 0;
  if (row.status === "valid" && (!row.validUntil || row.validUntil.getTime() > now.getTime())) {
    return { ...base, status: "valid", readOnly: false };
  }
  if (row.status === "unreachable" && graceEnd > now.getTime()) {
    return { ...base, status: "grace", readOnly: false, message: `License server unreachable; grace period until ${new Date(graceEnd).toISOString().slice(0, 10)}` };
  }
  if (row.status === "unreachable") return { ...base, status: "invalid", message: "License server unreachable for more than 14 days; the app is read-only" };
  return { ...base, status: "invalid", message: row.message ?? "License invalid" };
}

/** Validate against the server and record the result. Safe to call from cron or the UI. */
export async function checkLicense(app: FastifyInstance, client: LicenseClient, now = new Date()): Promise<LicenseState> {
  const key = (await getSetting(app.db, "license_key")) || null;
  if (!key) return currentState(app, now);
  const [prev] = await app.db.select().from(licenses).orderBy(desc(licenses.id)).limit(1);
  const inUse = await seatsInUse(app);
  let status: string;
  let message: string | null = null;
  let validUntil: Date | null = null;
  let seats: number | null = prev?.key === key ? (prev?.seats ?? null) : null;
  let lastValidAt: Date | null = prev?.key === key ? (prev?.lastValidAt ?? null) : null;
  let payload: Record<string, unknown> = {};
  try {
    const r = await client.validate({ key, instanceId: await instanceId(app), seatsInUse: inUse, version: app.config.RECAP_VERSION });
    payload = r as Record<string, unknown>;
    if (r.valid) {
      status = "valid";
      lastValidAt = now;
      validUntil = r.expires_at ? new Date(r.expires_at) : null;
      seats = r.max_seats ?? seats;
      if (seats !== null && inUse > seats) message = `Seat count exceeded: ${inUse} active users, ${seats} licensed`;
    } else {
      status = "invalid";
      message = r.message ?? "License rejected by the licensing server";
    }
  } catch (err) {
    status = "unreachable";
    message = `License server unreachable (${(err as Error).message})`;
  }
  await app.db.insert(licenses).values({ key, status, lastCheckedAt: now, lastValidAt, validUntil, seats, message, payload });
  const state = await currentState(app, now);
  // Mutate the shared decorator object: route handlers run in encapsulated child contexts
  // where assignment would only shadow the parent's value.
  Object.assign(app.licenseState, state);
  await audit(app.db, { actor: SYSTEM_LICENSE, action: "license.check", meta: { status: state.status, seats_in_use: inUse } });
  return state;
}

export async function setLicenseKey(app: FastifyInstance, key: string, updatedBy: string): Promise<void> {
  await setSetting(app.db, "license_key", key.trim(), updatedBy);
}
