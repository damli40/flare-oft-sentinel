import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getCustodyDeclaration } from "../services/custody.js";
import { assessSnapshot } from "../services/drift.js";
import type { OftSnapshot } from "../types.js";

const OFT = "0xAbC1111111111111111111111111111111111111";

function withDeclarationsFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
  writeFileSync(
    join(dir, "custody-declarations.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
  vi.stubEnv("DATA_DIR", dir);
  return dir;
}

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("getCustodyDeclaration", () => {
  it("returns null when the declarations file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    dirs.push(dir);
    vi.stubEnv("DATA_DIR", dir);
    expect(getCustodyDeclaration(OFT, 5000)).toBeNull();
  });

  it("returns the declaration for a chainId:address key, case-insensitive on the address", () => {
    dirs.push(withDeclarationsFile({
      // checksummed key, as a manual edit would likely write it
      [`5000:${OFT}`]: { custodyType: "fireblocks_mpc", declaredBy: "oft team (relayed)", declaredAt: "2026-07-07", verified: false },
    }));
    const decl = getCustodyDeclaration(OFT.toLowerCase(), 5000);
    expect(decl).toEqual({ custodyType: "fireblocks_mpc", declaredBy: "oft team (relayed)", declaredAt: "2026-07-07", verified: false });
  });

  it("returns null for a different chain or address", () => {
    dirs.push(withDeclarationsFile({
      [`5000:${OFT.toLowerCase()}`]: { custodyType: "fireblocks_mpc", declaredBy: "x", declaredAt: "2026-07-07", verified: false },
    }));
    expect(getCustodyDeclaration(OFT, 1)).toBeNull();
    expect(getCustodyDeclaration("0x9999999999999999999999999999999999999999", 5000)).toBeNull();
  });

  it("rejects declarations with a custodyType outside the allowed set", () => {
    dirs.push(withDeclarationsFile({
      [`5000:${OFT.toLowerCase()}`]: { custodyType: "trust_me_bro", declaredBy: "x", declaredAt: "2026-07-07", verified: false },
    }));
    expect(getCustodyDeclaration(OFT, 5000)).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", () => {
    dirs.push(withDeclarationsFile("{not-json"));
    expect(getCustodyDeclaration(OFT, 5000)).toBeNull();
  });
});

describe("assessSnapshot loads declarations from the store when not passed one", () => {
  it("downgrades a declared-MPC EOA owner to LOW via the file", async () => {
    dirs.push(withDeclarationsFile({
      [`5000:${OFT.toLowerCase()}`]: { custodyType: "fireblocks_mpc", declaredBy: "oft team (relayed)", declaredAt: "2026-07-07", verified: false },
    }));
    const snap: OftSnapshot = {
      oft: OFT,
      chainId: 5000,
      capturedAt: 1,
      owner: "0x2222222222222222222222222222222222222222",
      ownerIsContract: false,
      proxyAdmin: null,
      proxyAdminOwner: null,
      proxyAdminIsMultisig: null,
    proxyAdminOwnerIsContract: null,
      routes: [],
    };
    const { findings } = await assessSnapshot(snap);
    const f = findings.find((x) => x.check === "Owner Type");
    expect(f!.severity).toBe("LOW");
    expect(f!.custodyDeclaration?.custodyType).toBe("fireblocks_mpc");
  });
});
