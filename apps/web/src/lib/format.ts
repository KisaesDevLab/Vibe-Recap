import type { JobStatus } from "@vibe-recap/shared";

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const abs = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n < 0 ? `($${abs})` : `$${abs}`;
}

export function fmtPct(p: number | null | undefined): string {
  if (p === null || p === undefined) return "";
  return `${(p * 100).toFixed(1)}%`;
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  processing: "Processing",
  needs_review: "Needs review",
  approved: "Approved",
  released: "Released",
  purged: "Purged",
  failed: "Failed",
  rejected: "Rejected",
};

export const STATUS_TONE: Record<JobStatus, "slate" | "green" | "amber" | "red" | "blue"> = {
  queued: "slate",
  processing: "blue",
  needs_review: "amber",
  approved: "green",
  released: "green",
  purged: "slate",
  failed: "red",
  rejected: "red",
};

export function shortId(id: string): string {
  return id.slice(0, 8);
}
