import pino, { type LoggerOptions } from "pino";

/**
 * PII never reaches the log stream. Redaction happens here, at the logger level,
 * for every structured key that could carry a name, SSN, address, or amount.
 * Log job ids and file hashes instead.
 */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "res.headers['set-cookie']",
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.ssn",
  "*.email",
  "*.to",
  "*.from",
  "*.reply_to",
  "*.replyTo",
  "*.html",
  "*.name",
  "*.first_name",
  "*.last_name",
  "*.firstName",
  "*.lastName",
  "*.spouse_first_name",
  "*.taxpayer",
  "*.address",
  "*.amount",
  "*.amounts",
  "*.income",
  "*.payments",
  "*.result",
  "*.extraction",
  "*.script",
  "*.note",
  "*.notes",
];

/** URLs that carry a bearer secret in the path (client share links, Q73) are logged without it. */
export function maskUrl(url: string | undefined): string | undefined {
  return url?.replace(/^\/watch\/[^/?#]+/, "/watch/[token]");
}

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: {
      req(req: { method?: string; url?: string; host?: string; ip?: string; socket?: { remotePort?: number } }) {
        return { method: req.method, url: maskUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort };
      },
    },
    base: { service: "recap-api" },
  };
}

export function createLogger(level = "info") {
  return pino(loggerOptions(level));
}
