/**
 * Staff side of client sharing (Q73): create, revoke and re-issue a share from the job page, the
 * client-activity timeline, and Settings > Sharing. The client side is routes/watch.ts.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ShareDto, ShareEventDto, SharesResponse } from "@vibe-recap/shared";
import { files, jobEvents, jobShares, jobs, type JobShare, type ShareEvent } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { actorOf, requireRole } from "../plugins/auth.js";
import { audit } from "../services/audit.js";
import { EmailError, EmailNotConfigured } from "../services/email.js";
import { getAllSettings, setSetting, type SettingKey } from "../services/settings.js";
import { SmsError, sendSms, smsConfig } from "../services/sms.js";
import { createShare, listShares, normalizeContact, normalizePhone, recordShareEvent, shareBlocked, sharingStatus, type Channel } from "../services/shares.js";
import { loadJob } from "./jobs.js";

function toDto(s: JobShare, now = new Date()): ShareDto {
  const blocked = shareBlocked(s, now);
  const state: ShareDto["state"] = blocked === "revoked" ? "revoked" : blocked === "expired" || blocked === "wiped" ? "expired" : blocked === "locked" ? "locked" : s.sessionsUsed >= s.maxSessions ? "exhausted" : "active";
  return {
    id: s.id,
    channel: s.channel as Channel,
    contactMasked: s.contactMasked,
    secretRequired: s.secretRequired,
    state,
    createdAt: s.createdAt.toISOString(),
    createdByLabel: s.createdByLabel,
    expiresAt: s.expiresAt.toISOString(),
    maxSessions: s.maxSessions,
    sessionsUsed: s.sessionsUsed,
    failedAttempts: s.failedAttempts,
    cooldownUntil: s.cooldownUntil && s.cooldownUntil > now ? s.cooldownUntil.toISOString() : null,
    lockedAt: s.lockedAt?.toISOString() ?? null,
    revokedAt: s.revokedAt?.toISOString() ?? null,
    revokedByLabel: s.revokedByLabel,
    wiped: !!s.wipedAt,
    firstViewedAt: s.firstViewedAt?.toISOString() ?? null,
  };
}

function eventDto(e: ShareEvent): ShareEventDto {
  return { id: e.id, shareId: e.shareId, at: e.at.toISOString(), event: e.event, actorLabel: e.actorLabel, ip: e.ip, userAgent: e.userAgent, meta: e.meta };
}

function sendError(err: unknown): never {
  if (err instanceof EmailNotConfigured || err instanceof EmailError || err instanceof SmsError) throw badRequest(`The link was not sent: ${(err as Error).message}`);
  throw err;
}

const createBody = z.object({
  channel: z.enum(["email", "sms"]),
  contact: z.string().min(3).max(200),
  requireSecret: z.boolean(),
  last4: z.string().max(8).nullable().optional(),
});

export async function shareRoutes(app: FastifyInstance) {
  app.get("/api/jobs/:id/shares", { preHandler: requireRole("staff") }, async (req): Promise<SharesResponse> => {
    const { id } = req.params as { id: string };
    await loadJob(app.db, id);
    const status = await sharingStatus(app);
    const { shares, events } = await listShares(app, id);
    return {
      sharing: { enabled: status.enabled, reason: status.reason, channels: status.channels, channelReasons: status.channelReasons },
      shares: shares.map((s) => toDto(s)),
      events: events.map(eventDto),
    };
  });

  app.post("/api/jobs/:id/shares", { preHandler: requireRole("preparer"), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = createBody.parse(req.body);
    const row = await loadJob(app.db, id);
    if (!["approved", "released"].includes(row.job.status)) throw badRequest(`Only approved videos can be shared (this job is ${row.job.status})`);
    const [video] = await app.db.select({ id: files.id }).from(files).where(and(eq(files.jobId, id), eq(files.kind, "video"), isNull(files.purgedAt))).limit(1);
    if (!video) throw badRequest("This job has no video to share (purged or never rendered)");
    const status = await sharingStatus(app);
    if (!status.enabled) throw badRequest(status.reason ?? "Client sharing is not available");
    if (!status.channels[body.channel]) throw badRequest(`${body.channel === "sms" ? "Text messages are" : "Email is"} not set up: ${(status.channelReasons[body.channel] ?? "").toLowerCase()}`);
    const contact = normalizeContact(body.channel, body.contact);
    if (!contact) throw badRequest(body.channel === "sms" ? "Enter a mobile number, e.g. (555) 123-4567 or +44 20 7946 0958" : "Enter a valid email address");
    const last4 = body.last4?.trim() || null;
    if (body.requireSecret && !/^\d{4}$/.test(last4 ?? "")) throw badRequest("Enter the last four digits of the client's SSN, or turn that check off");

    const actor = actorOf(req);
    const { share } = await createShare(app, { jobId: id, channel: body.channel, contact, requireSecret: body.requireSecret, last4, actor }, req).catch(sendError);
    // Sharing is delivery, the same as a download: an approved job becomes released.
    if (row.job.status === "approved") {
      const now = new Date();
      await app.db.update(jobs).set({ status: "released", releasedAt: now, releasedBy: req.auth!.user.id, updatedAt: now }).where(eq(jobs.id, id));
      await app.db.insert(jobEvents).values({ jobId: id, status: "released", message: `released by ${req.auth!.user.email} (shared with client)` });
      await audit(app.db, { actor, action: "job.release", target: { type: "job", id }, ip: req.ip, meta: { script_sha256: row.job.approvedScriptSha256, via: "share", share_id: share.id } });
    }
    return { share: toDto(share) };
  });

  app.post("/api/jobs/:id/shares/:shareId/revoke", { preHandler: requireRole("preparer") }, async (req) => {
    const { id, shareId } = req.params as { id: string; shareId: string };
    const [share] = await app.db.select().from(jobShares).where(and(eq(jobShares.id, shareId), eq(jobShares.jobId, id))).limit(1);
    if (!share) throw notFound("Share not found");
    if (share.revokedAt) throw conflict("This share is already revoked");
    const actor = actorOf(req);
    await app.db.update(jobShares).set({ revokedAt: new Date(), revokedByLabel: actor.label }).where(eq(jobShares.id, shareId));
    await recordShareEvent(app, share, "revoked", { req, actor });
    return { ok: true };
  });

  /**
   * Re-issue: a fresh link (new token, new 7 days, sessions and failures reset) to the same contact
   * with the same last-4 check, and the old link revoked. Needs the old share's contact, which is
   * wiped when the share expires; after that the preparer creates a new share instead.
   */
  app.post("/api/jobs/:id/shares/:shareId/reissue", { preHandler: requireRole("preparer"), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { id, shareId } = req.params as { id: string; shareId: string };
    const [old] = await app.db.select().from(jobShares).where(and(eq(jobShares.id, shareId), eq(jobShares.jobId, id))).limit(1);
    if (!old) throw notFound("Share not found");
    if (!old.contactWrapped) throw badRequest("This share has ended and its contact was erased; create a new share instead");
    const row = await loadJob(app.db, id);
    if (!["approved", "released"].includes(row.job.status)) throw badRequest(`Only approved videos can be shared (this job is ${row.job.status})`);
    const status = await sharingStatus(app);
    if (!status.enabled) throw badRequest(status.reason ?? "Client sharing is not available");
    const channel = old.channel as Channel;
    if (!status.channels[channel]) throw badRequest(`${channel === "sms" ? "Text messages are" : "Email is"} not set up`);
    const contact = await app.storage.unwrapSecret(old.contactWrapped);
    const actor = actorOf(req);
    const { share } = await createShare(app, { jobId: id, channel, contact, requireSecret: old.secretRequired, last4: null, secretHash: old.secretHash, actor }, req).catch(sendError);
    if (!old.revokedAt) {
      await app.db.update(jobShares).set({ revokedAt: new Date(), revokedByLabel: actor.label }).where(eq(jobShares.id, old.id));
      await recordShareEvent(app, old, "revoked", { req, actor, meta: { reissued_as: share.id } });
    }
    await recordShareEvent(app, share, "reissued", { req, actor, meta: { replaces: old.id }, audited: false });
    return { share: toDto(share) };
  });

  // ---- Settings > Sharing ------------------------------------------------------------------

  const keys = ["share_enabled", "share_public_url", "sms_provider", "twilio_account_sid", "twilio_from"] as const satisfies readonly SettingKey[];

  async function view() {
    const s = await getAllSettings(app.db);
    const status = await sharingStatus(app);
    const sms = await smsConfig(app);
    return {
      settings: Object.fromEntries(keys.map((k) => [k, s[k]])),
      authTokenSet: sms.authTokenSet,
      authTokenSource: sms.authTokenSource,
      authTokenMasked: s.twilio_auth_token ? `…${s.twilio_auth_token.slice(-4)}` : null,
      envSms: { provider: app.config.SMS_PROVIDER.trim().toLowerCase() || "none", accountSidSet: !!app.config.TWILIO_ACCOUNT_SID, fromSet: !!(app.config.TWILIO_FROM || app.config.FROM_NUMBER) },
      effectivePublicUrl: status.publicUrl,
      envPublicUrl: app.config.SHARE_PUBLIC_URL,
      status,
    };
  }

  app.get("/api/settings/sharing", { preHandler: requireRole("admin") }, async () => view());

  app.put("/api/settings/sharing", { preHandler: requireRole("admin") }, async (req) => {
    const body = z
      .object({
        share_enabled: z.boolean().optional(),
        share_public_url: z.string().max(200).optional(),
        sms_provider: z.enum(["", "none", "twilio"]).optional(),
        twilio_account_sid: z.string().max(64).optional(),
        /** Omit to keep the stored token; empty string clears it. */
        twilio_auth_token: z.string().max(128).optional(),
        twilio_from: z.string().max(64).optional(),
      })
      .parse(req.body);
    const url = body.share_public_url?.trim().replace(/\/+$/, "");
    if (url && !/^https:\/\/[^/\s]+$/i.test(url)) throw badRequest("The watch address must look like https://watch.yourfirm.com (https, no path)");
    const staffUrl = ((await getAllSettings(app.db)).public_url || app.config.PUBLIC_URL).trim().replace(/\/+$/, "");
    if (url && staffUrl && url.toLowerCase() === staffUrl.toLowerCase()) throw badRequest("The watch address must be a different hostname from the staff address");
    const sid = body.twilio_account_sid?.trim();
    if (sid && !/^AC[0-9a-f]{32}$/i.test(sid)) throw badRequest("A Twilio account SID starts with AC followed by 32 hex characters");
    let from = body.twilio_from?.trim();
    if (from && !/^MG[0-9a-f]{32}$/i.test(from)) {
      const phone = normalizePhone(from);
      if (!phone) throw badRequest("The sending number must be a phone number (e.g. +15551234567) or a Messaging Service SID (MG…)");
      from = phone;
    }
    const user = req.auth!.user;
    const changed: string[] = [];
    const values: Partial<Record<(typeof keys)[number], unknown>> = { ...body, share_public_url: url, twilio_account_sid: sid, twilio_from: from };
    for (const k of keys) {
      const v = values[k];
      if (v === undefined) continue;
      await setSetting(app.db, k, v as never, user.id);
      changed.push(k);
    }
    if (body.twilio_auth_token !== undefined) {
      await setSetting(app.db, "twilio_auth_token", body.twilio_auth_token.trim(), user.id);
      changed.push(body.twilio_auth_token.trim() ? "twilio_auth_token" : "twilio_auth_token:cleared");
    }
    await audit(app.db, { actor: actorOf(req), action: "settings.update", target: { type: "settings", id: "sharing" }, ip: req.ip, meta: { keys: changed } });
    return view();
  });

  /** Send a test text to a number the admin types (their own phone). */
  app.post("/api/settings/sharing/test-sms", { preHandler: requireRole("admin"), config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ to: z.string().max(40) }).parse(req.body ?? {});
    const to = normalizePhone(body.to);
    if (!to) throw badRequest("Enter a mobile number");
    const firm = (await getAllSettings(app.db)).firm_name.trim() || "Vibe Recap";
    try {
      const r = await sendSms(app, to, "test", `${firm}: text messages from Vibe Recap are working. Sent from Settings > Sharing by ${req.auth!.user.name}.`);
      await audit(app.db, { actor: actorOf(req), action: "settings.sms_test", ip: req.ip, meta: { ok: true } });
      return { ok: true, id: r.id };
    } catch (err) {
      await audit(app.db, { actor: actorOf(req), action: "settings.sms_test", ip: req.ip, meta: { ok: false, error: (err as Error).message.slice(0, 200) } });
      throw badRequest((err as Error).message);
    }
  });
}
