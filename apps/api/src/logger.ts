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

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "recap-api" },
  };
}

export function createLogger(level = "info") {
  return pino(loggerOptions(level));
}
