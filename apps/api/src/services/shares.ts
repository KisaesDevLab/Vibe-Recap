/**
 * Client sharing (Q73). A share is a link to one approved video on the public watch host.
 *
 *   link     256-bit random token, only its sha256 stored; valid SHARE_DAYS days
 *   code     6 digits, sent on request to the contact the preparer entered (never one the client
 *            types), single use, CODE_TTL_S seconds, stored hashed in Redis
 *   last 4   optional per share, Argon2id hash on the share row, wiped when the share ends
 *   sessions a passed check opens a SESSION_TTL_S viewing session; at most MAX_SESSIONS per share
 *   lockout  wrong code or last 4 count together: a cooldown after every COOLDOWN_EVERY failures,
 *            a permanent lock at LOCK_AT failures; the preparer re-issues
 *
 * Messages carry the firm's name, the link or the code, and the expiry date. Never the client's
 * name, never a figure from the return.
 *
 * Return link (Q75): optionally, the URL where the client reviews and e-signs the return in the
 * firm's other app. Shown on the watch page as a button only after the client verifies; wrapped
 * like the contact and wiped with it; audited by hostname only.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { jobShares, jobs, shareEvents, type JobShare } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { emailConfig, isEmailAddress, sendEmail } from "./email.js";
import { shareCodeEmail, shareLinkEmail } from "./email-templates.js";
import { sendSms, smsConfig } from "./sms.js";
import { getAllSettings } from "./settings.js";
import { audit, type Actor } from "./audit.js";

export const SHARE_DAYS = 7;
export const MAX_SESSIONS = 5;
export const SESSION_TTL_S = 2 * 60 * 60;
export const CODE_TTL_S = 10 * 60;
export const CODE_RESEND_S = 60;
export const MAX_CODES = 10;
export const COOLDOWN_EVERY = 3;
export const COOLDOWN_MINUTES = 15;
export const LOCK_AT = 10;

export const CLIENT_ACTOR: Actor = { id: null, label: "client:share" };
export const SYSTEM_SHARES: Actor = { id: null, label: "system:shares" };

export type Channel = "email" | "sms";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** E.164 from what a preparer types; US 10-digit numbers get +1. Null when it is not a phone number. */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function normalizeContact(channel: Channel, raw: string): string | null {
  if (channel === "email") {
    const e = raw.trim().toLowerCase();
    return isEmailAddress(e) ? e : null;
  }
  return normalizePhone(raw);
}

export const RETURN_URL_MAX = 2000;

/**
 * The return / e-sign link as stored: an https URL with no credentials. Null for "no link".
 * Throws ReturnUrlError with a message for the preparer.
 */
export class ReturnUrlError extends Error {}

export function normalizeReturnUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (s.length > RETURN_URL_MAX) throw new ReturnUrlError(`The link is longer than ${RETURN_URL_MAX} characters`);
  if (/\s/.test(s)) throw new ReturnUrlError("The link must not contain spaces");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ReturnUrlError("Paste the full link, starting with https://");
  }
  if (u.protocol !== "https:") throw new ReturnUrlError("The link must start with https://");
  if (u.username || u.password) throw new ReturnUrlError("The link must not contain a user name or password");
  if (!u.hostname) throw new ReturnUrlError("Paste the full link, starting with https://");
  return u.href;
}

export function maskContact(channel: Channel, contact: string): string {
  if (channel === "sms") return `••• ••• ${contact.slice(-4)}`;
  const [local = "", domain = ""] = contact.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** Where the client opens the link: the share_public_url setting, then SHARE_PUBLIC_URL. Empty = sharing unavailable. */
export async function sharePublicUrl(app: FastifyInstance): Promise<string> {
  const s = await getAllSettings(app.db);
  for (const c of [s.share_public_url, app.config.SHARE_PUBLIC_URL]) {
    const v = c.trim().replace(/\/+$/, "");
    if (/^https:\/\/[^/\s]+$/i.test(v)) return v;
  }
  return "";
}

export interface SharingStatus {
  enabled: boolean;
  reason: string | null;
  publicUrl: string;
  channels: { email: boolean; sms: boolean };
  channelReasons: { email: string | null; sms: string | null };
}

export async function sharingStatus(app: FastifyInstance): Promise<SharingStatus> {
  const s = await getAllSettings(app.db);
  const publicUrl = await sharePublicUrl(app);
  const email = await emailConfig(app);
  const sms = await smsConfig(app);
  const channels = { email: email.enabled, sms: sms.enabled };
  const channelReasons = { email: email.reason, sms: sms.reason };
  let reason: string | null = null;
  if (!s.share_enabled) reason = "Client sharing is off";
  else if (!publicUrl) reason = "No public watch address (https://…)";
  else if (!channels.email && !channels.sms) reason = "Neither email nor text messages are set up";
  return { enabled: reason === null, reason, publicUrl, channels, channelReasons };
}

export function shareUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/watch/${token}`;
}

/** Why a share cannot be used right now, or null when it can. Order matters: the most final reason wins. */
export function shareBlocked(share: JobShare, now = new Date()): "wiped" | "revoked" | "expired" | "locked" | null {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt <= now) return "expired";
  if (share.wipedAt) return "wiped";
  if (share.lockedAt) return "locked";
  return null;
}

export async function recordShareEvent(
  app: FastifyInstance,
  share: Pick<JobShare, "id" | "jobId">,
  event: string,
  opts: { req?: FastifyRequest; actor?: Actor; meta?: Record<string, unknown>; audited?: boolean } = {},
): Promise<void> {
  const ua = opts.req?.headers["user-agent"];
  await app.db.insert(shareEvents).values({
    shareId: share.id,
    jobId: share.jobId,
    event,
    actorLabel: opts.actor?.label ?? CLIENT_ACTOR.label,
    ip: opts.req?.ip ?? null,
    userAgent: typeof ua === "string" ? ua.slice(0, 300) : null,
    meta: opts.meta ?? {},
  });
  // The audit log is never purged, so client IP and browser stay on share_events only.
  if (opts.audited !== false) {
    const actor = opts.actor ?? CLIENT_ACTOR;
    await audit(app.db, {
      actor,
      action: `share.${event}`,
      target: { type: "job", id: share.jobId },
      ip: actor.id ? (opts.req?.ip ?? null) : null,
      meta: { share_id: share.id, ...(opts.meta ?? {}) },
    });
  }
}

async function firmName(app: FastifyInstance): Promise<string> {
  return (await getAllSettings(app.db)).firm_name.trim();
}

function expiryText(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: process.env.TZ || "America/Chicago" });
}

export async function sendLinkMessage(app: FastifyInstance, channel: Channel, contact: string, url: string, expiresAt: Date): Promise<void> {
  const firm = await firmName(app);
  if (channel === "email") {
    await sendEmail(app, contact, "share_link", shareLinkEmail({ firmName: firm, url, expires: expiryText(expiresAt) }));
  } else {
    await sendSms(app, contact, "share_link", `${firm || "Your tax preparer"}: your tax return summary video is ready. Open ${url} and we will text you a code to confirm it is you. The link expires ${expiryText(expiresAt)}.`);
  }
}

async function sendCodeMessage(app: FastifyInstance, channel: Channel, contact: string, code: string): Promise<void> {
  const firm = await firmName(app);
  const minutes = CODE_TTL_S / 60;
  if (channel === "email") {
    await sendEmail(app, contact, "share_code", shareCodeEmail({ firmName: firm, code, minutes }));
  } else {
    await sendSms(app, contact, "share_code", `${code} is your ${firm || "video"} verification code. It expires in ${minutes} minutes.`);
  }
}

export interface CreateShareInput {
  jobId: string;
  channel: Channel;
  contact: string; // normalized
  requireSecret: boolean;
  last4: string | null;
  /** Re-issue: reuse an existing Argon2id hash instead of hashing last4. */
  secretHash?: string | null;
  /** Normalized return / e-sign link (normalizeReturnUrl), or null. */
  returnUrl?: string | null;
  /** Re-issue: carry the old share's wrapped link and host over as they are. */
  returnUrlCarried?: { wrapped: string | null; host: string | null };
  actor: Actor;
}

/** Create the share row and send the link. When the message cannot be sent, the row is removed and the error rethrown. */
export async function createShare(app: FastifyInstance, input: CreateShareInput, req?: FastifyRequest): Promise<{ share: JobShare; url: string }> {
  const publicUrl = await sharePublicUrl(app);
  const token = newShareToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SHARE_DAYS * 86400_000);
  const secretHash = input.requireSecret ? (input.secretHash ?? (input.last4 ? await hashPassword(input.last4) : null)) : null;
  const returnUrl = input.returnUrlCarried
    ? { wrapped: input.returnUrlCarried.wrapped, host: input.returnUrlCarried.host }
    : input.returnUrl
      ? { wrapped: await app.storage.wrapSecret(input.returnUrl), host: new URL(input.returnUrl).hostname }
      : { wrapped: null, host: null };
  const [share] = await app.db
    .insert(jobShares)
    .values({
      jobId: input.jobId,
      tokenHash: sha256(token),
      channel: input.channel,
      contactWrapped: await app.storage.wrapSecret(input.contact),
      contactMasked: maskContact(input.channel, input.contact),
      secretHash,
      secretRequired: input.requireSecret,
      returnUrlWrapped: returnUrl.wrapped,
      returnUrlHost: returnUrl.host,
      maxSessions: MAX_SESSIONS,
      createdBy: input.actor.id,
      createdByLabel: input.actor.label,
      expiresAt,
    })
    .returning();
  const url = shareUrl(publicUrl, token);
  try {
    await sendLinkMessage(app, input.channel, input.contact, url, expiresAt);
  } catch (err) {
    await app.db.delete(jobShares).where(eq(jobShares.id, share!.id));
    throw err;
  }
  await recordShareEvent(app, share!, "created", { req, actor: input.actor, meta: { channel: input.channel, secret_required: input.requireSecret, expires_at: expiresAt.toISOString(), ...(returnUrl.host ? { return_link_host: returnUrl.host } : {}) } });
  return { share: share!, url };
}

/** Set, replace or remove a share's return / e-sign link (normalized already). Audited by hostname only. */
export async function setReturnUrl(app: FastifyInstance, share: JobShare, url: string | null, opts: { req?: FastifyRequest; actor: Actor }): Promise<JobShare> {
  const host = url ? new URL(url).hostname : null;
  const [row] = await app.db
    .update(jobShares)
    .set({ returnUrlWrapped: url ? await app.storage.wrapSecret(url) : null, returnUrlHost: host })
    .where(eq(jobShares.id, share.id))
    .returning();
  await recordShareEvent(app, share, url ? "return_link_set" : "return_link_cleared", { ...opts, meta: host ? { host } : { previous_host: share.returnUrlHost } });
  return row!;
}

/** The return / e-sign link to show a verified client, or null. A stored value that no longer validates is dropped. */
export async function returnUrlFor(app: FastifyInstance, share: JobShare): Promise<string | null> {
  if (!share.returnUrlWrapped) return null;
  try {
    return normalizeReturnUrl(await app.storage.unwrapSecret(share.returnUrlWrapped));
  } catch {
    return null;
  }
}

export async function shareByToken(app: FastifyInstance, token: string): Promise<JobShare | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await app.db.select().from(jobShares).where(eq(jobShares.tokenHash, sha256(token))).limit(1);
  return row ?? null;
}

const codeKey = (shareId: string) => `share:code:${shareId}`;
const resendKey = (shareId: string) => `share:resend:${shareId}`;
const sessionKey = (hash: string) => `share:sess:${hash}`;

export type CodeOutcome = { ok: true; masked: string } | { ok: false; status: number; message: string };

export async function requestCode(app: FastifyInstance, share: JobShare, req: FastifyRequest): Promise<CodeOutcome> {
  const now = new Date();
  const blocked = shareBlocked(share, now);
  if (blocked) return { ok: false, status: 410, message: blocked === "locked" ? "This link is locked. Contact your preparer for a new one." : "This link is no longer available." };
  if (share.cooldownUntil && share.cooldownUntil > now) return { ok: false, status: 429, message: `Too many attempts. Try again after ${share.cooldownUntil.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.` };
  if (share.sessionsUsed >= share.maxSessions) return { ok: false, status: 410, message: "This link has been used the maximum number of times. Contact your preparer for a new one." };
  if (share.codesSent >= MAX_CODES) return { ok: false, status: 429, message: "Too many codes have been sent for this link. Contact your preparer for a new one." };
  if (!(await app.redis.set(resendKey(share.id), "1", "EX", CODE_RESEND_S, "NX"))) return { ok: false, status: 429, message: "A code was just sent. Wait a minute before asking for another." };
  if (!share.contactWrapped) return { ok: false, status: 410, message: "This link is no longer available." };
  const contact = await app.storage.unwrapSecret(share.contactWrapped);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await app.redis.set(codeKey(share.id), sha256(`${share.id}:${code}`), "EX", CODE_TTL_S);
  try {
    await sendCodeMessage(app, share.channel as Channel, contact, code);
  } catch (err) {
    await app.redis.del(codeKey(share.id), resendKey(share.id));
    app.log.warn({ shareId: share.id, err: (err as Error).message }, "share code not sent");
    await recordShareEvent(app, share, "code_failed", { req, meta: { error: (err as Error).message.slice(0, 200) } });
    return { ok: false, status: 502, message: "We could not send the code just now. Try again in a few minutes." };
  }
  await app.db.update(jobShares).set({ codesSent: share.codesSent + 1 }).where(eq(jobShares.id, share.id));
  await recordShareEvent(app, share, "code_sent", { req });
  return { ok: true, masked: share.contactMasked };
}

export type VerifyOutcome = { ok: true; sessionToken: string } | { ok: false; status: number; message: string };

export async function verifyShare(app: FastifyInstance, share: JobShare, input: { code: string; last4?: string | null }, req: FastifyRequest): Promise<VerifyOutcome> {
  const now = new Date();
  const blocked = shareBlocked(share, now);
  if (blocked) return { ok: false, status: 410, message: blocked === "locked" ? "This link is locked. Contact your preparer for a new one." : "This link is no longer available." };
  if (share.cooldownUntil && share.cooldownUntil > now) return { ok: false, status: 429, message: `Too many attempts. Try again after ${share.cooldownUntil.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.` };
  if (share.sessionsUsed >= share.maxSessions) return { ok: false, status: 410, message: "This link has been used the maximum number of times. Contact your preparer for a new one." };

  const stored = await app.redis.get(codeKey(share.id));
  const given = sha256(`${share.id}:${input.code.trim()}`);
  const codeOk = !!stored && stored.length === given.length && timingSafeEqual(Buffer.from(stored), Buffer.from(given));
  let secretOk = true;
  if (share.secretRequired) secretOk = !!share.secretHash && /^\d{4}$/.test(input.last4 ?? "") && (await verifyPassword(share.secretHash, input.last4!));

  if (!codeOk || !secretOk) {
    const failed = share.failedAttempts + 1;
    const lock = failed >= LOCK_AT;
    const cooldown = !lock && failed % COOLDOWN_EVERY === 0 ? new Date(now.getTime() + COOLDOWN_MINUTES * 60_000) : null;
    await app.db
      .update(jobShares)
      .set({ failedAttempts: failed, ...(lock ? { lockedAt: now } : {}), ...(cooldown ? { cooldownUntil: cooldown } : {}) })
      .where(eq(jobShares.id, share.id));
    await recordShareEvent(app, share, "verify_failed", { req, meta: { attempt: failed, code_ok: codeOk, secret_ok: share.secretRequired ? secretOk : null } });
    if (lock) {
      await app.redis.del(codeKey(share.id));
      await recordShareEvent(app, share, "locked", { req, meta: { attempts: failed } });
      return { ok: false, status: 423, message: "Too many incorrect attempts. This link is now locked; contact your preparer for a new one." };
    }
    if (cooldown) {
      await recordShareEvent(app, share, "cooldown", { req, meta: { until: cooldown.toISOString() } });
      return { ok: false, status: 429, message: `Too many incorrect attempts. Try again in ${COOLDOWN_MINUTES} minutes.` };
    }
    return { ok: false, status: 400, message: share.secretRequired ? "The code or the last four digits are not right. Check both and try again." : "That code is not right, or it has expired. Check it and try again." };
  }

  // One session per passed check; the counter is bumped conditionally so two racing checks cannot exceed the cap.
  const bumped = await app.db
    .update(jobShares)
    .set({ sessionsUsed: share.sessionsUsed + 1 })
    .where(and(eq(jobShares.id, share.id), eq(jobShares.sessionsUsed, share.sessionsUsed)))
    .returning({ id: jobShares.id });
  if (!bumped.length) return { ok: false, status: 409, message: "Please try again." };
  await app.redis.del(codeKey(share.id));
  const sessionToken = randomBytes(32).toString("base64url");
  await app.redis.set(sessionKey(sha256(sessionToken)), share.id, "EX", SESSION_TTL_S);
  await recordShareEvent(app, share, "verified", { req, meta: { session: share.sessionsUsed + 1, of: share.maxSessions } });
  return { ok: true, sessionToken };
}

/** The share a viewing-session cookie belongs to, when it matches this share and the share is still usable. */
export async function sessionValid(app: FastifyInstance, share: JobShare, sessionToken: string | undefined): Promise<boolean> {
  if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return false;
  if (shareBlocked(share)) return false;
  return (await app.redis.get(sessionKey(sha256(sessionToken)))) === share.id;
}

/** First play of a session: one timeline entry per session, not one per range request. */
export async function notePlayed(app: FastifyInstance, share: JobShare, sessionToken: string, req: FastifyRequest): Promise<void> {
  if (!(await app.redis.set(`share:played:${sha256(sessionToken)}`, "1", "EX", SESSION_TTL_S, "NX"))) return;
  const now = new Date();
  const first = await app.db
    .update(jobShares)
    .set({ firstViewedAt: now })
    .where(and(eq(jobShares.id, share.id), isNull(jobShares.firstViewedAt)))
    .returning({ id: jobShares.id });
  await recordShareEvent(app, share, "played", { req });
  // The client watching is delivery (Q73): tick the job's Delivered box, unless a preparer already did.
  if (first.length) {
    const marked = await app.db
      .update(jobs)
      .set({ delivered: true, deliveredNote: `watched via share link ${now.toISOString().slice(0, 10)}`, updatedAt: now })
      .where(and(eq(jobs.id, share.jobId), eq(jobs.delivered, false)))
      .returning({ id: jobs.id });
    if (marked.length) await audit(app.db, { actor: CLIENT_ACTOR, action: "job.delivered", target: { type: "job", id: share.jobId }, meta: { via: "share", share_id: share.id } });
  }
}

/** Forget the contact, the last-4 hash and the return link. Idempotent. */
export async function wipeShare(app: FastifyInstance, share: Pick<JobShare, "id" | "jobId">, event: "expired" | "job_purged", now = new Date()): Promise<void> {
  const wiped = await app.db
    .update(jobShares)
    .set({ contactWrapped: null, secretHash: null, returnUrlWrapped: null, returnUrlHost: null, wipedAt: now })
    .where(and(eq(jobShares.id, share.id), isNull(jobShares.wipedAt)))
    .returning({ id: jobShares.id });
  if (wiped.length) {
    await app.redis.del(codeKey(share.id));
    await recordShareEvent(app, share, event, { actor: SYSTEM_SHARES });
  }
}

/** Cron: wipe every share past its expiry. Returns how many were wiped. */
export async function sweepShares(app: FastifyInstance, now = new Date()): Promise<number> {
  const due = await app.db
    .select({ id: jobShares.id, jobId: jobShares.jobId })
    .from(jobShares)
    .where(and(isNull(jobShares.wipedAt), lt(jobShares.expiresAt, now)));
  for (const s of due) await wipeShare(app, s, "expired", now);
  return due.length;
}

/** Job purge: wipe the job's shares and drop client IP and browser from its timeline. */
export async function purgeJobShares(app: FastifyInstance, jobId: string, now = new Date()): Promise<void> {
  const rows = await app.db.select({ id: jobShares.id, jobId: jobShares.jobId }).from(jobShares).where(and(eq(jobShares.jobId, jobId), isNull(jobShares.wipedAt)));
  for (const s of rows) await wipeShare(app, s, "job_purged", now);
  await app.db.update(shareEvents).set({ ip: null, userAgent: null }).where(eq(shareEvents.jobId, jobId));
}

export async function listShares(app: FastifyInstance, jobId: string) {
  const shares = await app.db.select().from(jobShares).where(eq(jobShares.jobId, jobId)).orderBy(desc(jobShares.createdAt));
  const events = shares.length
    ? await app.db
        .select()
        .from(shareEvents)
        .where(inArray(shareEvents.shareId, shares.map((s) => s.id)))
        .orderBy(desc(shareEvents.at))
    : [];
  return { shares, events };
}
