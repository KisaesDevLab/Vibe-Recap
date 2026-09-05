/**
 * Client-side mirror of worker/recap/validate.py. Gives the editor live feedback and lets the
 * API reject an obviously bad manual edit before the worker re-validates. The Python validator
 * is the authority; keep the rules in step.
 */
import type { ExtractionDto } from "./dto.js";

export const SLIDE_ORDER = ["greeting", "income", "deductions", "tax", "result", "observations", "next"] as const;
export const MIN_WORDS = 250;
export const MAX_WORDS = 450;

const TAG_RE = /\[\[slide:([a-z_]+)\]\]/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const ADDRESS_RE = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s){0,3}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Boulevard|Blvd\.?|Court|Ct\.?|Way|Circle|Cir\.?|Place|Pl\.?)\b/;
const AMOUNT_RE = /\(?-?\$?\d(?:[\d,]*\d)?(?:\.\d{1,2})?\)?-?/g;
const PCT_RE = /(?<![\w.])(-?\d+(?:\.\d+)?)\s*%/g;
const BARE_NUM_RE = /(?<![\w$.,-])(\d{1,3}(?:,\d{3})+|\d{3,})(?![\w,.]*\d)(?!\s*%)/g;

export interface ScriptValidation {
  ok: boolean;
  errors: string[];
  wordCount: number;
}

export function stripTags(script: string): string {
  return script.replace(TAG_RE, " ");
}

export function slideSections(script: string): Array<{ slide: string; text: string }> {
  const out: Array<{ slide: string; text: string }> = [];
  const re = /\[\[slide:([a-z_]+)\]\]/g;
  let m: RegExpExecArray | null;
  const marks: Array<{ slide: string; start: number; end: number }> = [];
  while ((m = re.exec(script))) marks.push({ slide: m[1]!, start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const next = marks[i + 1];
    out.push({ slide: marks[i]!.slide, text: script.slice(marks[i]!.end, next ? next.start : undefined).trim() });
  }
  return out;
}

export function wordCount(script: string): number {
  return (stripTags(script).match(/[A-Za-z0-9$][\w$',.%-]*/g) ?? []).length;
}

function walkInts(obj: unknown, out: Set<number>) {
  if (typeof obj === "number" && Number.isInteger(obj)) out.add(Math.abs(obj));
  else if (Array.isArray(obj)) obj.forEach((v) => walkInts(v, out));
  else if (obj && typeof obj === "object") Object.values(obj).forEach((v) => walkInts(v, out));
}

export function allowedAmounts(ex: ExtractionDto): Set<number> {
  const out = new Set<number>();
  for (const k of ["income", "adjustments", "deductions", "tax", "payments", "result", "state", "prior_year"] as const) walkInts(ex[k], out);
  for (const o of ex.observations) if (Number.isInteger(o.delta)) out.add(Math.abs(o.delta));
  return out;
}

export function allowedPercents(ex: ExtractionDto): number[] {
  const out: number[] = [];
  if (ex.tax.effective_rate) out.push(Math.round(ex.tax.effective_rate * 1000) / 10);
  for (const o of ex.observations) if (o.pct) out.push(Math.round(Math.abs(o.pct) * 1000) / 10);
  return out;
}

export function parseAmount(token: string): number | null {
  const t = token.trim();
  if (t === "" || t === "-" || t === "-0-") return 0;
  const m = /^\(?\s*-?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*\)?-?$/.exec(t);
  if (!m) return null;
  let n = parseInt(m[1]!.replace(/,/g, ""), 10);
  if (m[2]) n = Math.floor(n + parseInt(m[2].padEnd(2, "0"), 10) / 100 + 0.5);
  const negative = t.startsWith("(") || t.startsWith("-") || t.endsWith("-") || t.startsWith("$-");
  return negative ? -n : n;
}

export function validateScript(script: string, ex: ExtractionDto): ScriptValidation {
  const errors: string[] = [];
  const tags = [...script.matchAll(/\[\[slide:([a-z_]+)\]\]/g)].map((m) => m[1]!);
  if (tags.join(",") !== SLIDE_ORDER.join(",")) {
    const missing = SLIDE_ORDER.filter((t) => !tags.includes(t));
    const extra = tags.filter((t) => !(SLIDE_ORDER as readonly string[]).includes(t));
    const dup = [...new Set(tags.filter((t, i) => tags.indexOf(t) !== i))];
    const detail: string[] = [];
    if (missing.length) detail.push("missing " + missing.map((t) => `[[slide:${t}]]`).join(", "));
    if (extra.length) detail.push("unknown " + extra.join(", "));
    if (dup.length) detail.push("duplicated " + dup.join(", "));
    if (!detail.length) detail.push("wrong order; use " + SLIDE_ORDER.map((t) => `[[slide:${t}]]`).join(" "));
    errors.push("slide tags: " + detail.join("; "));
  }
  const wc = wordCount(script);
  if (wc < MIN_WORDS) errors.push(`too short: ${wc} words, need at least ${MIN_WORDS}`);
  else if (wc > MAX_WORDS) errors.push(`too long: ${wc} words, keep it under ${MAX_WORDS}`);

  const body = stripTags(script);
  if (SSN_RE.test(body)) errors.push("contains a Social Security number pattern; never include it");
  if (EMAIL_RE.test(body)) errors.push("contains an email address; remove it");
  if (ADDRESS_RE.test(body)) errors.push("contains a street address; remove it");

  const amounts = allowedAmounts(ex);
  const pcts = allowedPercents(ex);
  const years = new Set<number>(ex.meta.tax_year ? [ex.meta.tax_year - 1, ex.meta.tax_year, ex.meta.tax_year + 1] : []);
  for (const m of body.matchAll(AMOUNT_RE)) {
    const tok = m[0];
    const end = m.index! + tok.length;
    if (body[end] === "%") continue;
    if (!tok.includes("$") && !tok.includes(",")) continue;
    const v = parseAmount(tok);
    if (v === null) continue;
    if (!amounts.has(Math.abs(v))) errors.push(`amount ${tok} does not appear in the extracted return figures`);
  }
  for (const m of body.matchAll(PCT_RE)) {
    const v = Math.abs(parseFloat(m[1]!));
    const ok = pcts.some((a) => Math.abs(v - a) <= 0.1 || (Number.isInteger(v) && Math.round(a) === v));
    if (!ok) errors.push(`percentage ${m[0].trim()} is not one of the computed figures`);
  }
  for (const m of body.matchAll(BARE_NUM_RE)) {
    const tok = m[1]!;
    if (tok.includes(",")) continue;
    const n = parseInt(tok, 10);
    if (n < 100 || years.has(n) || n === 1040 || amounts.has(n)) continue;
    errors.push(`number ${tok} does not appear in the extracted return figures`);
  }
  return { ok: errors.length === 0, errors, wordCount: wc };
}
