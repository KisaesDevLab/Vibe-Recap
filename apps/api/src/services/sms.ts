/**
 * Text messages for client sharing (Q73): the share link and the one-time code, nothing else.
 * Twilio is the only provider. api.twilio.com is contacted only when an admin has turned SMS on.
 *
 * Contract (Twilio Messages, https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource):
 *   POST {TWILIO_API_URL}/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Authorization: Basic base64(AccountSid:AuthToken)
 *   form: To=+1..., Body=..., From=+1... | MessagingServiceSid=MG...
 *   -> 201 { sid: "SM...", status: "queued", ... }
 *   -> 4xx { code: 21211, message: "...", more_info: "..." }
 */
import type { FastifyInstance } from "fastify";
import { getAllSettings } from "./settings.js";

export interface OutboundSms {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
}

export interface SmsClient {
  send(msg: OutboundSms): Promise<{ id: string | null }>;
}

export class SmsError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
  }
}

export class TwilioClient implements SmsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(msg: OutboundSms): Promise<{ id: string | null }> {
    const form = new URLSearchParams({ To: msg.to, Body: msg.body });
    if (/^MG[0-9a-f]{32}$/i.test(msg.from)) form.set("MessagingServiceSid", msg.from);
    else form.set("From", msg.from);
    let res: Response;
    try {
      res = await fetch(new URL(`/2010-04-01/Accounts/${encodeURIComponent(msg.accountSid)}/Messages.json`, this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${msg.accountSid}:${msg.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SmsError(`Twilio unreachable (${(err as Error).message})`);
    }
    const data = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok) {
      const hint = res.status === 401 ? " (check the account SID and auth token)" : res.status === 429 ? " (rate limited)" : "";
      throw new SmsError(`Twilio refused the message: ${data.message ?? `HTTP ${res.status}`}${data.code ? ` [${data.code}]` : ""}${hint}`, res.status);
    }
    return { id: data.sid ?? null };
  }
}

export interface SmsConfig {
  enabled: boolean;
  accountSid: string;
  authTokenSet: boolean;
  authTokenSource: "settings" | "env" | null;
  from: string;
  reason: string | null;
}

/** Resolve the effective Twilio configuration from settings with env fallbacks. */
export async function smsConfig(app: FastifyInstance): Promise<SmsConfig & { authToken: string }> {
  const s = await getAllSettings(app.db);
  const accountSid = (s.twilio_account_sid || app.config.TWILIO_ACCOUNT_SID).trim();
  const authToken = (s.twilio_auth_token || app.config.TWILIO_AUTH_TOKEN).trim();
  const from = (s.twilio_from || app.config.TWILIO_FROM).trim();
  const base = {
    enabled: false,
    accountSid,
    authToken,
    authTokenSet: !!authToken,
    authTokenSource: s.twilio_auth_token ? ("settings" as const) : app.config.TWILIO_AUTH_TOKEN ? ("env" as const) : null,
    from,
    reason: null as string | null,
  };
  if (s.sms_provider !== "twilio") return { ...base, reason: "Text messages are off" };
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) return { ...base, reason: "No valid Twilio account SID" };
  if (!authToken) return { ...base, reason: "No Twilio auth token" };
  if (!/^\+[1-9]\d{6,14}$/.test(from) && !/^MG[0-9a-f]{32}$/i.test(from)) return { ...base, reason: "No valid sending number or messaging service" };
  return { ...base, enabled: true };
}

/** Send one text. Throws SmsError when Twilio refuses or SMS is off. Logs the kind and the provider id only. */
export async function sendSms(app: FastifyInstance, to: string, kind: string, body: string): Promise<{ id: string | null }> {
  const cfg = await smsConfig(app);
  if (!cfg.enabled) throw new SmsError(cfg.reason ? `Text messages are not available: ${cfg.reason.toLowerCase()}` : "Text messages are not configured");
  const result = await app.smsClient.send({ accountSid: cfg.accountSid, authToken: cfg.authToken, from: cfg.from, to, body });
  app.log.info({ kind, providerId: result.id }, "sms sent");
  return result;
}
