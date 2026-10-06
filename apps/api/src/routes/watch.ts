/**
 * The client's watch page (Q73): the only routes the public watch host serves. Caddy's watch site
 * forwards /watch/* here and answers 404 for everything else, so the staff UI and /api/* are not
 * reachable through the tunnel.
 *
 *   GET  /watch/:token                 the page (verify form, or the player once verified)
 *   POST /watch/:token/code            send a one-time code to the contact on the share
 *   POST /watch/:token/verify          check the code (and last 4), open a viewing session
 *   GET  /watch/:token/video.mp4       the approved video, range requests, session required
 *   GET  /watch/:token/captions.vtt    its captions, session required
 *
 * The page is rendered here, not by the React app, so the public host serves no staff code. Its
 * one script and one stylesheet carry a per-response nonce under a strict CSP.
 *
 * Once verified, the page may also carry a button to the return / e-sign link the preparer pasted
 * (Q75): a plain link out to the firm's other app, never shown before verification.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { files, jobs, type FileRow, type JobShare } from "../db/schema.js";
import { escapeHtml } from "../services/email-templates.js";
import { DEFAULT_RETURN_LABEL, getAllSettings } from "../services/settings.js";
import { notePlayed, requestCode, returnUrlFor, sessionValid, shareBlocked, shareByToken, sharePublicUrl, verifyShare, SESSION_TTL_S } from "../services/shares.js";

const COOKIE = "recap_watch";
const PLAYABLE: string[] = ["approved", "released"];

/** Decrypted videos kept briefly, so seeking does not decrypt the whole file per range request. */
const cache = new Map<string, { bytes: Buffer; at: number }>();
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 3;

async function cachedBytes(app: FastifyInstance, file: FileRow): Promise<Buffer> {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  const hit = cache.get(file.id);
  if (hit) return hit.bytes;
  const bytes = Buffer.from(await app.storage.get(file.path, file.keyPath));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(file.id, { bytes, at: now });
  return bytes;
}

async function liveFile(app: FastifyInstance, jobId: string, kind: "video" | "vtt"): Promise<FileRow | null> {
  const [row] = await app.db
    .select()
    .from(files)
    .where(and(eq(files.jobId, jobId), eq(files.kind, kind), isNull(files.purgedAt)))
    .orderBy(desc(files.createdAt))
    .limit(1);
  return row ?? null;
}

async function playable(app: FastifyInstance, share: JobShare): Promise<boolean> {
  const [job] = await app.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, share.jobId)).limit(1);
  return !!job && PLAYABLE.includes(job.status) && !!(await liveFile(app, share.jobId, "video"));
}

function cookieValue(req: FastifyRequest): string | undefined {
  return req.cookies[COOKIE];
}

/** A state-changing request from a browser must come from the watch host itself (or the staff host while testing on the LAN). */
async function sameOrigin(app: FastifyInstance, req: FastifyRequest): Promise<boolean> {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = [await sharePublicUrl(app), ...app.config.ALLOWED_ORIGIN.split(",")].map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (allowed.includes(origin.replace(/\/$/, ""))) return true;
  return origin === `${req.protocol}://${req.host}`;
}

function securityHeaders(reply: FastifyReply, nonce?: string) {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("x-robots-tag", "noindex, nofollow");
  if (nonce) {
    reply.header(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; media-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
  }
}

type PageState =
  | { kind: "gone"; message: string }
  | { kind: "verify"; masked: string; channel: string; secretRequired: boolean; sessionsLeft: number; expires: string }
  | { kind: "watch"; token: string; hasCaptions: boolean; expires: string; returnUrl: string | null; returnLabel: string };

function renderPage(o: { firm: string; logo: string | null; color: string; state: PageState; nonce: string }): string {
  const firm = escapeHtml(o.firm || "Your tax preparer");
  const color = /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : "#1f3a5f";
  const logo = o.logo && /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(o.logo) ? `<img class="logo" src="${o.logo}" alt="">` : "";
  let body = "";
  const s = o.state;
  if (s.kind === "gone") {
    body = `<h1>Video not available</h1><p>${escapeHtml(s.message)}</p><p class="muted">If you need the video, contact ${firm}.</p>`;
  } else if (s.kind === "verify") {
    const via = s.channel === "sms" ? "a text message" : "an email";
    body = `<h1>Your tax return summary</h1>
<p>${firm} prepared a short video about your tax return. To confirm it is you, we will send a one-time code by ${via} to <strong>${escapeHtml(s.masked)}</strong>.</p>
<button id="send" type="button">Send my code</button>
<form id="verify" hidden>
  <label for="code">Verification code</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
  ${s.secretRequired ? `<label for="last4">Last four digits of your Social Security number</label>
  <input id="last4" name="last4" inputmode="numeric" autocomplete="off" pattern="[0-9]{4}" maxlength="4" required>` : ""}
  <button type="submit">Watch the video</button>
  <button id="resend" class="link" type="button">Send a new code</button>
</form>
<p id="msg" role="status" aria-live="polite"></p>
<p class="muted">The link expires ${escapeHtml(s.expires)}. It can be opened ${s.sessionsLeft} more time${s.sessionsLeft === 1 ? "" : "s"}; each opening lasts ${SESSION_TTL_S / 3600} hours.</p>`;
  } else {
    body = `<h1>Your tax return summary</h1>
<video controls playsinline preload="metadata" controlsList="nodownload noplaybackrate" disablepictureinpicture>
  <source src="/watch/${s.token}/video.mp4" type="video/mp4">
  ${s.hasCaptions ? `<track kind="captions" srclang="en" label="English" src="/watch/${s.token}/captions.vtt" default>` : ""}
</video>
${s.returnUrl ? `<p><a class="btn" href="${escapeHtml(s.returnUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.returnLabel)}</a></p>` : ""}
<p class="muted">Prepared by ${firm}. The link expires ${escapeHtml(s.expires)}. Questions about your return? Contact ${firm}.</p>`;
  }
  const script =
    s.kind === "verify"
      ? `<script nonce="${o.nonce}">
(function(){
  var base = location.pathname.replace(/\\/$/, "");
  var msg = document.getElementById("msg"), form = document.getElementById("verify"), send = document.getElementById("send");
  function say(t, bad){ msg.textContent = t; msg.className = bad ? "bad" : ""; }
  async function post(path, body){
    var r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" });
    var d = {}; try { d = await r.json(); } catch (e) {}
    return { ok: r.ok, d: d };
  }
  async function ask(){
    send.disabled = true; say("Sending…");
    var r = await post("/code");
    send.disabled = false;
    if (r.ok) { send.hidden = true; form.hidden = false; say("We sent a code to " + r.d.sentTo + ". It expires in 10 minutes."); document.getElementById("code").focus(); }
    else say(r.d.message || "Something went wrong. Try again.", true);
  }
  send.addEventListener("click", ask);
  document.getElementById("resend").addEventListener("click", ask);
  form.addEventListener("submit", async function(e){
    e.preventDefault();
    var last4 = document.getElementById("last4");
    say("Checking…");
    var r = await post("/verify", { code: document.getElementById("code").value, last4: last4 ? last4.value : null });
    if (r.ok) location.assign(base); else say(r.d.message || "Something went wrong. Try again.", true);
  });
})();
</script>`
      : s.kind === "watch"
        ? `<script nonce="${o.nonce}">document.querySelector("video").addEventListener("contextmenu", function(e){ e.preventDefault(); });</script>`
        : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${firm}: your tax return summary</title>
<style nonce="${o.nonce}">
:root{--brand:${color};--ink:#1e293b;--muted:#64748b;--bg:#f5f6f8;--card:#fff;--line:#e2e8f0}
@media (prefers-color-scheme: dark){:root{--ink:#e2e8f0;--muted:#94a3b8;--bg:#0f172a;--card:#1e293b;--line:#334155}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}
header{display:flex;align-items:center;gap:12px;margin-bottom:16px}.logo{max-height:48px;max-width:180px}
.firm{font-weight:600;color:var(--brand)}@media (prefers-color-scheme: dark){.firm{color:var(--ink)}}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px}
h1{font-size:20px;margin:0 0 12px}p{margin:12px 0}.muted{color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 4px}
input{width:100%;max-width:240px;font-size:20px;letter-spacing:2px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
button{margin-top:16px;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}button.link{background:none;color:var(--brand);padding:10px 6px;font-weight:500}
@media (prefers-color-scheme: dark){button.link{color:var(--ink)}}
a.btn{display:inline-block;margin-top:8px;background:var(--brand);color:#fff;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;text-decoration:none}
.bad{color:#b91c1c}video{width:100%;border-radius:8px;background:#000}
</style></head>
<body><main><header>${logo}<span class="firm">${firm}</span></header><section>${body}</section></main>${script}</body></html>`;
}

function expiryText(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: process.env.TZ || "America/Chicago" });
}

export async function watchRoutes(app: FastifyInstance) {
  // The token is a secret: keep it out of the request log (logger.ts masks /watch/<token> as well).
  app.get("/watch/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const nonce = randomBytes(16).toString("base64");
    const s = await getAllSettings(app.db);
    securityHeaders(reply, nonce);
    reply.type("text/html; charset=utf-8");
    const share = await shareByToken(app, token);
    let state: PageState;
    const blocked = share ? shareBlocked(share) : "expired";
    if (!share || blocked) {
      state = { kind: "gone", message: blocked === "locked" ? "This link was locked after too many incorrect attempts." : "This link has expired or is no longer valid." };
      reply.code(share ? 410 : 404);
    } else if (!(await playable(app, share))) {
      state = { kind: "gone", message: "This video is no longer available." };
      reply.code(410);
    } else if (await sessionValid(app, share, cookieValue(req))) {
      state = {
        kind: "watch",
        token,
        hasCaptions: !!(await liveFile(app, share.jobId, "vtt")),
        expires: expiryText(share.expiresAt),
        returnUrl: await returnUrlFor(app, share),
        returnLabel: s.share_return_label.trim() || DEFAULT_RETURN_LABEL,
      };
    } else if (share.sessionsUsed >= share.maxSessions) {
      state = { kind: "gone", message: "This link has been used the maximum number of times." };
      reply.code(410);
    } else {
      state = { kind: "verify", masked: share.contactMasked, channel: share.channel, secretRequired: share.secretRequired, sessionsLeft: share.maxSessions - share.sessionsUsed, expires: expiryText(share.expiresAt) };
    }
    return renderPage({ firm: s.firm_name.trim(), logo: s.firm_logo, color: s.color_primary, state, nonce });
  });

  app.post("/watch/:token/code", { config: { csrf: false, rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    securityHeaders(reply);
    if (!(await sameOrigin(app, req))) return reply.code(403).send({ message: "Not allowed" });
    const { token } = req.params as { token: string };
    const share = await shareByToken(app, token);
    if (!share || !(await playable(app, share))) return reply.code(404).send({ message: "This link is no longer available." });
    const r = await requestCode(app, share, req);
    if (!r.ok) return reply.code(r.status).send({ message: r.message });
    return { ok: true, sentTo: r.masked };
  });

  app.post("/watch/:token/verify", { config: { csrf: false, rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    securityHeaders(reply);
    if (!(await sameOrigin(app, req))) return reply.code(403).send({ message: "Not allowed" });
    const { token } = req.params as { token: string };
    const body = z.object({ code: z.string().max(12), last4: z.string().max(8).nullable().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ message: "Enter the 6-digit code." });
    const share = await shareByToken(app, token);
    if (!share || !(await playable(app, share))) return reply.code(404).send({ message: "This link is no longer available." });
    const r = await verifyShare(app, share, { code: body.data.code, last4: body.data.last4 ?? null }, req);
    if (!r.ok) return reply.code(r.status).send({ message: r.message });
    // Lax, not Strict: a client who clicks the emailed link again within the session must land on
    // the player, not spend another session. The cookie only unlocks GETs of this share's video.
    reply.setCookie(COOKIE, r.sessionToken, { path: `/watch/${token}`, httpOnly: true, secure: app.config.COOKIE_SECURE, sameSite: "lax", maxAge: SESSION_TTL_S });
    return { ok: true };
  });

  for (const [ext, kind, contentType] of [
    ["video.mp4", "video", "video/mp4"],
    ["captions.vtt", "vtt", "text/vtt; charset=utf-8"],
  ] as const) {
    app.get(`/watch/:token/${ext}`, async (req, reply) => {
      securityHeaders(reply);
      const { token } = req.params as { token: string };
      const share = await shareByToken(app, token);
      const session = cookieValue(req);
      if (!share || !(await sessionValid(app, share, session))) return reply.code(403).send({ message: "Verify first." });
      if (!(await playable(app, share))) return reply.code(410).send({ message: "This video is no longer available." });
      const file = await liveFile(app, share.jobId, kind);
      if (!file) return reply.code(404).send({ message: "Not found" });
      const bytes = await cachedBytes(app, file);
      reply.header("content-type", contentType);
      reply.header("content-disposition", "inline");
      if (kind === "vtt") return reply.send(bytes);
      reply.header("accept-ranges", "bytes");
      const range = req.headers.range;
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      let start = 0;
      let end = bytes.length - 1;
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = parseInt(m[1], 10);
          if (m[2]) end = Math.min(parseInt(m[2], 10), bytes.length - 1);
        } else {
          start = Math.max(0, bytes.length - parseInt(m[2]!, 10)); // suffix range: the last N bytes
        }
        if (start > end || start >= bytes.length) {
          reply.header("content-range", `bytes */${bytes.length}`);
          return reply.code(416).send();
        }
        reply.code(206);
        reply.header("content-range", `bytes ${start}-${end}/${bytes.length}`);
      }
      if (start === 0) await notePlayed(app, share, session!, req);
      reply.header("content-length", String(end - start + 1));
      return reply.send(bytes.subarray(start, end + 1));
    });
  }
}
