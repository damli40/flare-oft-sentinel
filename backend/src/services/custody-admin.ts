import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { dirname, join } from "path";
import type { CustodyDeclaration } from "../types.js";
import { ALLOWED_CUSTODY_TYPES, declarationsFile } from "./custody.js";

// Admin-side counterpart to custody.ts. The engine reads the declarations file
// fail-safe (malformed input = no declaration, never an error); the admin API is
// the opposite: it must reject bad input loudly so a mistake is caught at save
// time instead of silently un-downgrading a declared setup on the next assessment.

const KEY_RE = /^\d+:0x[0-9a-fA-F]{40}$/;

export function readDeclarations(): Record<string, CustodyDeclaration> {
  const file = declarationsFile();
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, CustodyDeclaration>;
  } catch {
    return {};
  }
}

/**
 * Validate a full replacement declarations object. Returns a human-readable
 * reason naming the offending key, or null when valid. Extra fields on an
 * entry are tolerated (forward-compatible); the four required fields must be
 * present and well-typed.
 */
export function validateDeclarations(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "body must be a JSON object keyed by chainId:oftAddress";
  }
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(body)) {
    if (!KEY_RE.test(key)) {
      return `invalid key "${key}": expected "<chainId>:<0x-address>" (e.g. "5000:0xabc...")`;
    }
    // The engine matches keys case-insensitively, so two keys differing only
    // in address case would be ambiguous — reject rather than pick one.
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) return `duplicate key "${key}" (addresses match case-insensitively)`;
    seen.add(normalized);

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return `"${key}": declaration must be an object`;
    }
    const d = value as Record<string, unknown>;
    if (typeof d.custodyType !== "string" || !ALLOWED_CUSTODY_TYPES.has(d.custodyType)) {
      return `"${key}": custodyType must be one of ${[...ALLOWED_CUSTODY_TYPES].join(" | ")}`;
    }
    if (typeof d.declaredBy !== "string" || d.declaredBy.trim() === "") {
      return `"${key}": declaredBy must be a non-empty string`;
    }
    if (typeof d.declaredAt !== "string" || d.declaredAt.trim() === "") {
      return `"${key}": declaredAt must be a non-empty string (ISO date)`;
    }
    if (typeof d.verified !== "boolean") {
      return `"${key}": verified must be a boolean`;
    }
  }
  return null;
}

/**
 * Atomically replace the declarations file: write a temp file in the same
 * directory, then rename over the target. A crash mid-save can never leave a
 * half-written file for the engine to read.
 */
export function writeDeclarations(declarations: Record<string, CustodyDeclaration>): void {
  const file = declarationsFile();
  const tmp = join(dirname(file), ".custody-declarations.json.tmp");
  writeFileSync(tmp, JSON.stringify(declarations, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}
