import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

// Every mutating route on the sentinel router that has no shipped UI caller must
// be unreachable without ADMIN_TOKEN. The backend goes on a public URL, and
// POST /poll runs the real cycle: it signs from the attestor wallet and writes to
// the on-chain registry. "No button in the UI" removed the accidental path; only
// a route-level gate removes the deliberate one.
//
// The cycle itself is NEVER run here. services/sentinel.js is mocked wholesale,
// so a request that clears the gate increments a spy — nothing signs, nothing
// alerts, nothing touches a chain.

const TOKEN = "test-admin-token";

/** Routes the UI actually calls, or that are read-only by construction. They
 *  must stay open, so the gate is also tested for what it must NOT close. */
const UNGATED_POST = new Set(["/ask", "/validate"]);

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

type Spies = Record<
  "pollOnce" | "runKelpReplay" | "runLibraryRevertReplay" | "runRpcConflictReplay" | "resetDemo",
  ReturnType<typeof vi.fn>
>;

let server: ReturnType<express.Express["listen"]> | null = null;

beforeEach(() => vi.resetModules());
afterEach(() => {
  server?.close();
  server = null;
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Boot the REAL sentinel router in-process against mocked services. */
async function startRouter(): Promise<{ base: string; spies: Spies; router: express.Router }> {
  const spies: Spies = {
    pollOnce: vi.fn().mockResolvedValue(undefined),
    runKelpReplay: vi.fn().mockResolvedValue({ ok: true }),
    runLibraryRevertReplay: vi.fn().mockResolvedValue({ ok: true }),
    runRpcConflictReplay: vi.fn().mockResolvedValue({ ok: true }),
    resetDemo: vi.fn(),
  };
  vi.doMock("../services/sentinel.js", () => ({
    ...spies,
    getWatched: vi.fn().mockResolvedValue([]),
    getWatchlistHealth: () => ({ degraded: false, reasons: [], lastRefreshAt: 1, servedStaleAt: null }),
  }));
  const { router } = await import("../routes/sentinel.js");
  const app = express();
  app.use(express.json());
  app.use("/api/sentinel", router);
  server = app.listen(0);
  await new Promise((r) => server!.once("listening", r));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, spies, router };
}

function post(base: string, path: string, token?: string) {
  return fetch(`${base}/api/sentinel${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: "{}",
  });
}

/** Every POST route the router declares, minus the ones that ship a UI caller.
 *  Reading the router's own stack rather than a hand-written list means a
 *  mutating route added later is covered the day it is added — the enumeration
 *  is the test, not a comment about the test. */
function gatedPaths(router: express.Router): string[] {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const paths = stack
    .filter((l) => l.route?.methods.post)
    .map((l) => l.route!.path)
    .filter((p) => !UNGATED_POST.has(p));
  expect(paths.length, "no POST routes found — the router internals changed").toBeGreaterThan(0);
  return paths;
}

// One representative of each family, named so a failure says which one broke.
// The full set is covered by the enumeration test below.
const SAMPLES = [
  { path: "/poll", spy: "pollOnce" },
  { path: "/replay-library-revert", spy: "runLibraryRevertReplay" },
] as const;

describe.each(SAMPLES)("POST $path is gated by ADMIN_TOKEN", ({ path, spy }) => {
  it("404s when ADMIN_TOKEN is unset — the route does not exist", async () => {
    vi.stubEnv("ADMIN_TOKEN", undefined);
    const { base, spies } = await startRouter();

    const res = await post(base, path, TOKEN);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(spies[spy]).not.toHaveBeenCalled();
  });

  it("404s when ADMIN_TOKEN is empty — unset never means open", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    const { base, spies } = await startRouter();

    const res = await post(base, path, "");

    expect(res.status).toBe(404);
    expect(spies[spy]).not.toHaveBeenCalled();
  });

  it("401s on a wrong token", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const { base, spies } = await startRouter();

    const res = await post(base, path, "wrong-token");

    expect(res.status).toBe(401);
    expect(spies[spy]).not.toHaveBeenCalled();
  });

  it("401s when no token is presented at all", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const { base, spies } = await startRouter();

    const res = await post(base, path);

    expect(res.status).toBe(401);
    expect(spies[spy]).not.toHaveBeenCalled();
  });

  it("runs for the operator with the correct token", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const { base, spies } = await startRouter();

    const res = await post(base, path, TOKEN);

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(spies[spy]).toHaveBeenCalledTimes(1);
  });
});

describe("every mutating route without a UI caller is gated", () => {
  it("all of them 404 with ADMIN_TOKEN unset, and none of their services run", async () => {
    vi.stubEnv("ADMIN_TOKEN", undefined);
    const { base, spies, router } = await startRouter();

    const statuses = await Promise.all(
      gatedPaths(router).map(async (p) => [p, (await post(base, p, TOKEN)).status] as const),
    );

    expect(Object.fromEntries(statuses)).toEqual(
      Object.fromEntries(statuses.map(([p]) => [p, 404])),
    );
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("all of them 401 on a wrong token, and none of their services run", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const { base, spies, router } = await startRouter();

    const statuses = await Promise.all(
      gatedPaths(router).map(async (p) => [p, (await post(base, p, "wrong-token")).status] as const),
    );

    expect(Object.fromEntries(statuses)).toEqual(
      Object.fromEntries(statuses.map(([p]) => [p, 401])),
    );
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the gate does not close the routes the UI depends on", () => {
  it("POST /ask and POST /validate answer without a token", async () => {
    vi.stubEnv("ADMIN_TOKEN", TOKEN);
    const { base } = await startRouter();

    // /ask rejects an empty question on its own terms (400), /validate answers a
    // body-less unpaid request with its x402 challenge (402). Neither is the
    // gate's 404/401 — which is the whole assertion.
    const ask = await post(base, "/ask");
    const validate = await post(base, "/validate");

    expect(ask.status).toBe(400);
    expect(validate.status).toBe(402);
  });
});
