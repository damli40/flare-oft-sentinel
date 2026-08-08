import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This server arrived from the upstream Mantle deployment, where every default
// was correct. Ported here they were all wrong in the same quiet way: a judge
// running the install command would have read a different fleet and verified
// attestations against a chain this instance never wrote to, and every answer
// would have looked right. These checks fail loudly if a wrong-chain default
// comes back.
//
// Scope is the shipped server and its README. The test directory is excluded on
// purpose: chain.test.ts names the retired env var in order to prove it is dead.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");
const PKG = join(here, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const files = sourceFiles(SRC);
const readme = readFileSync(join(PKG, "README.md"), "utf8");
const shipped: Array<[string, string]> = [
  ...files.map((f) => [relative(PKG, f), readFileSync(f, "utf8")] as [string, string]),
  ["README.md", readme],
];

describe("every default describes THIS instance", () => {
  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(shipped)("%s points at no other deployment's chain", (_name, text) => {
    expect(text).not.toMatch(/sepolia/i);
    expect(text).not.toMatch(/mantlescan/i);
    expect(text).not.toMatch(/backend-production-d16e/);
    // Substring-safe: the Flare site is flare-oft-sentinel.netlify.app, so match
    // the scheme too or the correct URL trips the check for the wrong one.
    expect(text).not.toContain("https://oft-sentinel.netlify.app");
  });

  // The fault-neutral check moved into the hashed sweep below. Spelling the
  // forbidden words here made this file the only place in the repository that
  // contained them, and the export's own vocabulary gate flagged it, correctly.

  it("the README carries no em dashes", () => {
    expect(readme).not.toContain("—");
  });
});

// ── the fixtures are covered too, because that is where it got through ──────
//
// The block above excludes __tests__, and the first import of this server put
// three real third-party assets in the fixtures: real tickers, real contract
// addresses pinned from a live production read, real verdicts (one AT_RISK, two
// CRITICAL), a real attestation id and the transaction hash that wrote it. In a
// public repository that is a published finding about somebody else's token,
// which this program routes to the asset's owner instead.
//
// A deny-list rather than a shape rule, deliberately. Real infrastructure
// addresses belong here: chain.test.ts names this instance's own registry, and
// the corridor fixtures name real DVN operators, which is the path the demo
// asset's rows exercise. What must not appear is a third party's ASSET identity
// attached to a verdict. Add to the list when a fixture starts naming one.

// sha256 of each lowercased term. Hashed rather than written out, because a
// deny-list of names IS the thing it forbids: the plaintext version published
// three third-party asset identities in the file whose job was to keep them out,
// and put the two incident words in the only file that carried them.
//
// Covered: three asset tickers, their contract addresses, the transaction hash
// of an attestation about one of them, and the two incident words. To add one,
// print sha256 of the lowercased term and paste the digest.
const FORBIDDEN_DIGESTS = new Set([
  "5668e7edcd8a3ef87b00fb57c11eaaa9f8a9067cff7fd9ff95c5a6ef7dee0cfb",
  "f744f377b58e02cd6609fe2ee0cf69cf79fbc45437f991a51b7cd7beff291874",
  "800bb7a921c82e774b8b28bcffb7b635dc15fddd83b5ae65952693b02e2d0b89",
  "8307ac5d98c7634406599c364066ff8d7ee25c09545fa8d674e43d224f5c3674",
  "fcbce704a4dd1f0e13c4b6a7c26135a6f96eafeb88ae218daa2436485b00c30b",
  "4ef2bde67dcbf97b416e00a4ce695e35d0b1006c209c02af0293576f743a6deb",
  "f07b85ac6a1225bb4a76171a948a7378aa6fcc1b83bd41ffe19010213e7d20be",
  "e6a74a24f90d8571e8fed43cfead08e64a24b4b7c5e74b7f5fa64b5d9d4828ac",
  "280f8bb8c43d532f389ef0e2a5321220b0782b065205dcdfcb8d8f02ed5115b9",
]);

/** Every word and every 0x-literal in a file, lowercased. Hashing needs whole
 *  tokens, so the file is tokenised rather than substring-searched. */
function tokens(text: string): string[] {
  return [
    ...(text.match(/0x[0-9a-fA-F]{6,}/g) ?? []),
    ...(text.match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? []),
  ].map((t) => t.toLowerCase());
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return allFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("no third-party asset identity ships in this repository", () => {
  const everything: Array<[string, string]> = [
    ...allFiles(SRC).map((f) => [relative(PKG, f), readFileSync(f, "utf8")] as [string, string]),
    ["README.md", readme],
  ];

  it("covers the test fixtures, which the checks above do not", () => {
    expect(everything.some(([name]) => name.includes("__tests__"))).toBe(true);
  });

  it.each(everything)("%s names no third party's asset", (name, text) => {
    const hits = [...new Set(tokens(text))].filter((t) => FORBIDDEN_DIGESTS.has(digest(t)));
    expect(
      hits.length,
      `${name} carries ${hits.length} forbidden term(s). A third party's asset ` +
        `identity, or an incident, belongs with that asset's owner and not in a ` +
        `public repository. The term is not printed here on purpose.`,
    ).toBe(0);
  });

  // Two anti-vacuous checks, because a sweep that matches nothing passes
  // silently. Neither names a real term: the mechanism is what is under test,
  // and printing a forbidden term to prove the guard works would defeat it.
  it("tokenises and matches a planted term", () => {
    const canary = "notarealticker";
    const set = new Set([digest(canary)]);
    const hits = tokens(`const ticker = "${canary}"; // 0xAbCdEf123456`).filter((t) => set.has(digest(t)));
    expect(hits).toEqual([canary]);
  });

  it("has a populated deny-list", () => {
    expect(FORBIDDEN_DIGESTS.size).toBe(9);
    for (const d of FORBIDDEN_DIGESTS) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});
