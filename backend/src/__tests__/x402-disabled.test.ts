import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "http";
import type { AddressInfo } from "net";

// Same two stubs validate-route.test.ts uses, and for the same reason: the
// engine runs for real, only its two network reads are doubled.
vi.mock("../services/lz-config.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/lz-config.js")>();
  return {
    ...actual,
    loadDvnMeta: vi.fn(async () => ({ byChain: {}, deadByChain: {}, fetchedAt: Date.now() })),
  };
});
vi.mock("../services/sentinel.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/sentinel.js")>();
  return { ...actual, getWatched: vi.fn(async () => []) };
});

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "x402-disabled-"));

// ── Why this file exists ─────────────────────────────────────────────────────
//
// POST /validate answers a body-less request with an x402 challenge, because
// this route is a listed agent service on ONE deployment. Every other instance
// inherits that code, so a public copy of this backend answered `402 Payment
// Required` to a bare GET — on a free endpoint, in a repository handed to
// hackathon judges, advertising a resource URL on a different host.
//
// X402_ENABLED gates it. The default must stay ON so the listed deployment is
// untouched by this change, which is the property most worth pinning here: a
// missing variable must never silence a live payment path.
//
// The flag is read at module load, so each case re-imports the router.

let server: Server | null = null;

async function boot(x402Enabled: string | undefined): Promise<string> {
  vi.resetModules();
  if (x402Enabled === undefined) delete process.env.X402_ENABLED;
  else process.env.X402_ENABLED = x402Enabled;

  const { router } = await import("../routes/sentinel.js");
  const app = express();
  app.use(express.json());
  app.use("/api/sentinel", router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/sentinel/validate`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  delete process.env.X402_ENABLED;
});

describe("X402_ENABLED", () => {
  it("unset keeps the challenge, so the listed deployment is unaffected", async () => {
    const base = await boot(undefined);
    for (const res of [await fetch(base), await fetch(base, { method: "POST" })]) {
      expect(res.status).toBe(402);
      expect(res.headers.get("payment-required")).toBeTruthy();
    }
  });

  it('"false" answers a body-less caller with what the endpoint wants, not a bill', async () => {
    const base = await boot("false");
    for (const res of [await fetch(base), await fetch(base, { method: "POST" })]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("payment-required")).toBeNull();
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.endpoint).toBe("POST /api/sentinel/validate");
      expect(body.cost).toBe("free");
      // The property a judge cares about, stated by the endpoint itself.
      expect(String(body.writes)).toMatch(/no attestation/i);
    }
  });

  it("a config still gets a verdict with the challenge disabled", async () => {
    const base = await boot("false");
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainKey: "flare",
        routes: [
          {
            eid: 30110,
            requiredDVNs: ["0x1111111111111111111111111111111111111111"],
            optionalDVNs: [],
            optionalDVNThreshold: 0,
            confirmations: 5,
            sendLibIsDefault: false,
            receiveLibIsDefault: false,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rulesVersion).toBe("5.0.0");
    expect(typeof body.score).toBe("number");
    expect(Array.isArray(body.findings)).toBe(true);
  });

  // Exact-string comparison, the ALERTS_DISABLED lesson: a truthy-looking value
  // that is not the exact string must not disable a live payment path. Anything
  // looser and a stray "False" in a deploy config silently stops the billing.
  it("only the exact string disables it", async () => {
    for (const value of ["False", "FALSE", "0", "no", "true", ""]) {
      const base = await boot(value);
      const res = await fetch(base);
      expect(res.status, `X402_ENABLED=${JSON.stringify(value)} must not disable the challenge`).toBe(402);
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });
});
