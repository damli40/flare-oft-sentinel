import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { router } from "../routes/declarations.js";
import { getCustodyDeclaration } from "../services/custody.js";

const TOKEN = "test-admin-token";
const OFT = "0xabc1111111111111111111111111111111111111";
const VALID = {
  [`5000:${OFT}`]: {
    custodyType: "fireblocks_mpc",
    declaredBy: "oft team (relayed)",
    declaredAt: "2026-07-07",
    verified: false,
  },
};

let server: Server;
let base: string;
let dataDir: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/sentinel/declarations", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sentinel/declarations`;
});

afterAll(() => server.close());

afterEach(() => {
  vi.unstubAllEnvs();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function freshDataDir(): string {
  dataDir = mkdtempSync(join(tmpdir(), "decl-api-test-"));
  vi.stubEnv("DATA_DIR", dataDir);
  return dataDir;
}

function put(body: unknown, token: string | null = TOKEN, contentType = "application/json") {
  return fetch(base, {
    method: "PUT",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": contentType,
    },
    body: JSON.stringify(body),
  });
}

describe("declarations API auth", () => {
  // Precondition for the test below, asserted rather than assumed. It reads the
  // AMBIENT environment on purpose — it does not stub ADMIN_TOKEN, because "unset"
  // is the state it is pinning. That only works if the suite scrubs the variable,
  // which setup.ts now does; without that line this file went red on any machine
  // whose shell exported ADMIN_TOKEN, on a build with nothing wrong with it.
  it("runs with no ambient ADMIN_TOKEN — setup.ts scrubs it", () => {
    expect(process.env.ADMIN_TOKEN).toBeUndefined();
  });

  it("returns 404 when ADMIN_TOKEN is unset (API does not exist)", async () => {
    freshDataDir();
    expect((await fetch(base)).status).toBe(404);
    expect((await put(VALID)).status).toBe(404);
    expect(existsSync(join(dataDir, "custody-declarations.json"))).toBe(false);
  });

  it("returns 401 on a missing token", async () => {
    freshDataDir();
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    expect((await fetch(base)).status).toBe(401);
    expect((await put(VALID, null)).status).toBe(401);
  });

  it("returns 401 on a wrong token", async () => {
    freshDataDir();
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    expect((await put(VALID, "wrong-token")).status).toBe(401);
    expect(existsSync(join(dataDir, "custody-declarations.json"))).toBe(false);
  });
});

describe("declarations API validation (400, file untouched)", () => {
  async function expectRejected(body: unknown, reasonPart: string) {
    freshDataDir();
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const res = await put(body);
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(reasonPart);
    expect(existsSync(join(dataDir, "custody-declarations.json"))).toBe(false);
  }

  it("rejects a non-object body", async () => {
    await expectRejected([VALID], "JSON object");
  });

  it("rejects a malformed key", async () => {
    await expectRejected({ "mantle:0x123": VALID[`5000:${OFT}`] }, "invalid key");
  });

  it("rejects a custodyType outside the allowed set", async () => {
    await expectRejected(
      { [`5000:${OFT}`]: { ...VALID[`5000:${OFT}`], custodyType: "trust_me_bro" } },
      "custodyType",
    );
  });

  it("rejects a missing verified flag", async () => {
    const { verified: _drop, ...rest } = VALID[`5000:${OFT}`];
    await expectRejected({ [`5000:${OFT}`]: rest }, "verified");
  });

  it("rejects a non-string declaredBy", async () => {
    await expectRejected(
      { [`5000:${OFT}`]: { ...VALID[`5000:${OFT}`], declaredBy: 42 } },
      "declaredBy",
    );
  });

  it("rejects keys that collide case-insensitively", async () => {
    await expectRejected(
      { [`5000:${OFT}`]: VALID[`5000:${OFT}`], [`5000:${OFT.toUpperCase().replace("0X", "0x")}`]: VALID[`5000:${OFT}`] },
      "duplicate",
    );
  });

  it("rejects a PUT without a JSON content-type instead of wiping the file", async () => {
    freshDataDir();
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    writeFileSync(join(dataDir, "custody-declarations.json"), JSON.stringify(VALID));
    const res = await put(VALID, TOKEN, "text/plain");
    expect(res.status).toBe(400);
    expect(JSON.parse(readFileSync(join(dataDir, "custody-declarations.json"), "utf8"))).toEqual(VALID);
  });
});

describe("declarations API round-trip", () => {
  it("valid PUT writes the file, GET round-trips, and the engine lookup resolves it", async () => {
    freshDataDir();
    vi.stubEnv("ADMIN_TOKEN", TOKEN);

    const putRes = await put(VALID);
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual(VALID);

    const getRes = await fetch(base, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(VALID);

    expect(getCustodyDeclaration(OFT, 5000)?.custodyType).toBe("fireblocks_mpc");
  });

  it("GET returns {} when no file exists", async () => {
    freshDataDir();
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const res = await fetch(base, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("PUT {} empties the declarations (removal path)", async () => {
    freshDataDir();
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    await put(VALID);
    expect(getCustodyDeclaration(OFT, 5000)).not.toBeNull();

    const res = await put({});
    expect(res.status).toBe(200);
    expect(getCustodyDeclaration(OFT, 5000)).toBeNull();
    expect(JSON.parse(readFileSync(join(dataDir, "custody-declarations.json"), "utf8"))).toEqual({});
  });
});
