import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { CustodyDeclaration, CustodyType } from "../types.js";

// Same JSON-persistence pattern as snapshot-store, but resolved per call and
// never cached: declarations arrive as manual edits to the file on the Railway
// [comment redacted for publication]
// a few entries — a read per assessment is nothing.
const DECLARATIONS_BASENAME = "custody-declarations.json";

export const ALLOWED_CUSTODY_TYPES: ReadonlySet<string> = new Set<CustodyType>([
  "eoa_hot",
  "fireblocks_mpc",
  "safe_multisig",
  "unknown",
]);

export function declarationsFile(): string {
  const dataDir = process.env.DATA_DIR
    ? resolve(process.env.DATA_DIR)
    : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
  return join(dataDir, DECLARATIONS_BASENAME);
}

/**
 * Look up the declared custody type for an OFT's owner key.
 * Keys are `${chainId}:${oftAddress}`; address comparison is case-insensitive
 * so manually edited checksummed keys still match. A malformed file or a
 * custodyType outside the allowed set reads as "no declaration" — bad manual
 * input must never alter a verdict.
 */
export function getCustodyDeclaration(oft: string, chainId: number): CustodyDeclaration | null {
  const file = declarationsFile();
  if (!existsSync(file)) return null;

  let raw: Record<string, CustodyDeclaration>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, CustodyDeclaration>;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;

  const wanted = `${chainId}:${oft.toLowerCase()}`;
  for (const [key, decl] of Object.entries(raw)) {
    if (key.toLowerCase() !== wanted) continue;
    if (!decl || typeof decl !== "object") return null;
    if (!ALLOWED_CUSTODY_TYPES.has(decl.custodyType)) return null;
    return decl;
  }
  return null;
}
