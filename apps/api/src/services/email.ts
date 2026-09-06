/**
 * Outgoing email (QUESTIONS.md Q48): transactional messages to the firm's own users through the
 * Emailit REST API. Recap never emails clients; the only messages are invites, password-reset
 * links, password-changed notices, and the admin's test message.
 *
 * Contract (Emailit v2, https://emailit.com/docs/api-reference/emails/send):
 *   POST {EMAILIT_API_URL}/v2/emails
 *   Authorization: Bearer <api key>
 *   { from: "Name <addr>" | "addr", to: string | string[], subject, html, text, reply_to? }
 *   -> 200 { object: "email", id: "em_...", status: "pending", ... }
 *   -> 4xx { error: string, validation_errors?: string[] }
 *
 * api.emailit.com is the API container's third permitted outbound destination (with the licensing
 * server and the Vibe AI Router) and is only contacted when an admin has enabled the provider.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAllSettings } from "./settings.js";

export interface OutboundEmail {
  apiKey: string;
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailClient {
  send(msg: OutboundEmail): Promise<{ id: string | null }>;
}

export class EmailError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
  }
}

export class EmailitClient implements EmailClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(msg: OutboundEmail): Promise<{ id: string | null }> {
    const body: Record<string, unknown> = {
      from: msg.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    };
    if (msg.replyTo) body.reply_to = msg.replyTo;
    let res: Response;
    try {
      res = await fetch(new URL("/v2/emails", this.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${msg.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new EmailError(`Emailit unreachable (${(err as Error).message})`);
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string; validation_errors?: string[] };
    if (!res.ok) {
      const detail = data.validation_errors?.join("; ") || data.error || data.message || `HTTP ${res.status}`;
      const hint = res.status === 401 || res.status === 403 ? "check the API key" : res.status === 429 ? "rate limited" : "";
      throw new EmailError(`Emailit refused the message: ${detail}${hint ? ` (${hint})` : ""}`, res.status);
    }
    return { id: data.id ?? null };
  }
}

export interface EmailConfig {
  enabled: boolean;
  provider: "none" | "emailit";
  apiKeySet: boolean;
  apiKeySource: "settings" | "env" | null;
  from: string;
  fromName: string;
  replyTo: string;
  /** Why `enabled` is false, for the settings page. */
  reason: string | null;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isEmailAddress(s: string): boolean {
  return ADDRESS.test(s);
}

/** Resolve the effective email configuration from settings with env fallbacks. Never returns the key. */
export async function emailConfig(app: FastifyInstance): Promise<EmailConfig & { apiKey: string }> {
  const s = await getAllSettings(app.db);
  const apiKey = s.emailit_api_key || app.config.EMAILIT_API_KEY || "";
  const from = s.email_from.trim();
  const base: EmailConfig & { apiKey: string } = {
    enabled: false,
    provider: s.email_provider,
    apiKeySet: !!apiKey,
    apiKeySource: s.emailit_api_key ? "settings" : app.config.EMAILIT_API_KEY ? "env" : null,
    from,
    fromName: s.email_from_name.trim() || s.firm_name.trim() || "Vibe Recap",
    replyTo: s.email_reply_to.trim(),
    reason: null,
    apiKey,
  };
  if (s.email_provider !== "emailit") return { ...base, reason: "Outgoing email is off" };
  if (!apiKey) return { ...base, reason: "No Emailit API key" };
  if (!isEmailAddress(from)) return { ...base, reason: "No valid sender address" };
  return { ...base, enabled: true };
}

export async function emailEnabled(app: FastifyInstance): Promise<boolean> {
  return (await emailConfig(app)).enabled;
}

/** RFC 5322 display-name form; quotes the name when it carries specials. */
export function formatSender(name: string, address: string): string {
  const clean = name.replace(/[\r\n"<>]/g, "").trim();
  if (!clean) return address;
  return /[^A-Za-z0-9 .'-]/.test(clean) ? `"${clean}" <${address}>` : `${clean} <${address}>`;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export class EmailNotConfigured extends Error {
  constructor(reason: string | null) {
    super(reason ? `Outgoing email is not available: ${reason.toLowerCase()}` : "Outgoing email is not configured");
  }
}

/**
 * Send one message to one firm user. Throws EmailNotConfigured when the provider is off and
 * EmailError when Emailit refuses or is unreachable. Logs the kind and the provider id only.
 */
export async function sendEmail(app: FastifyInstance, to: string, kind: string, content: EmailContent): Promise<{ id: string | null }> {
  const cfg = await emailConfig(app);
  if (!cfg.enabled) throw new EmailNotConfigured(cfg.reason);
  if (!isEmailAddress(to)) throw new EmailError("Recipient is not a valid email address");
  const result = await app.emailClient.send({
    apiKey: cfg.apiKey,
    from: formatSender(cfg.fromName, cfg.from),
    replyTo: cfg.replyTo || undefined,
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
  app.log.info({ kind, providerId: result.id }, "email sent");
  return result;
}

/** Like sendEmail but never throws; returns whether the message went out. Callers audit the outcome. */
export async function trySendEmail(app: FastifyInstance, to: string, kind: string, content: EmailContent): Promise<{ sent: boolean; error: string | null }> {
  try {
    await sendEmail(app, to, kind, content);
    return { sent: true, error: null };
  } catch (err) {
    if (!(err instanceof EmailNotConfigured)) app.log.warn({ kind, err: (err as Error).message }, "email not sent");
    return { sent: false, error: (err as Error).message };
  }
}

/**
 * The URL users open from an email: the public_url setting, then PUBLIC_URL, then the first
 * ALLOWED_ORIGIN (the appliance sets it), then the origin of the request that triggered the mail.
 */
export async function publicUrl(app: FastifyInstance, req?: FastifyRequest): Promise<string> {
  const s = await getAllSettings(app.db);
  const candidates = [s.public_url, app.config.PUBLIC_URL, app.config.ALLOWED_ORIGIN.split(",")[0] ?? ""];
  for (const c of candidates) {
    const v = c.trim().replace(/\/+$/, "");
    if (/^https?:\/\/[^/\s]+$/i.test(v)) return v;
  }
  if (req) {
    const origin = typeof req.headers.origin === "string" && /^https?:\/\/[^/\s]+$/i.test(req.headers.origin) ? req.headers.origin : null;
    return origin ?? `${req.protocol}://${req.host}`;
  }
  return "";
}
