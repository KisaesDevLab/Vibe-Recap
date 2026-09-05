import argon2 from "argon2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const MIN_PASSWORD_LENGTH = 12;

let commonPasswords: Set<string> | null = null;

function loadCommon(): Set<string> {
  if (commonPasswords) return commonPasswords;
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/common-passwords.txt");
  const set = new Set<string>();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const p = line.trim().toLowerCase();
      if (p) set.add(p);
    }
  } catch {
    // A missing list is a packaging error. app.ts logs loudly when the size is 0.
  }
  commonPasswords = set;
  return set;
}

export function commonPasswordListSize(): number {
  return loadCommon().size;
}

/** Returns a human-readable reason the password is rejected, or null when acceptable. */
export function checkPasswordPolicy(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (loadCommon().has(password.toLowerCase())) {
    return "That password appears in a list of commonly breached passwords; choose another";
  }
  return null;
}

const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
