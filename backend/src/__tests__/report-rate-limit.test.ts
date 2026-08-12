import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

// GET /report/:address builds a full markdown audit report, which calls the model.
// It shipped with no auth and no rate limit at all: reports are cached per
// snapshot, so repeat hits on ONE address are free, but a walk through distinct
// addresses is not — and the route is on a public URL.
//
// It now shares the Copilot's IP window instead of getting one of its own. The
// thing being protected is a single model budget, so two windows would just
// double what one IP can spend.
//
// Nothing calls a model here: services/report.js and services/ask.js are mocked,
// so a request that clears the limiter increments a spy.

const OFT = "0x560C03079FE54Fa53e15b48C615b1ef76D6DF621";
const LIMIT = 10;

let server: ReturnType<express.Express["listen"]> | null = null;

beforeEach(() => vi.resetModules());
afterEach(() => {
  server?.close();
  server = null;
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Boot the REAL sentinel router in-process. The window lives in module state, so
 *  the `vi.resetModules()` above gives every test a fresh, empty one. */
async function startRouter() {
  const generateReport = vi.fn().mockResolvedValue("# audit report");
  // Defaults to UNCACHED, which is what every test below already assumed: a
  // request that reaches the generator is a request that spends model budget and
  // therefore a slot. Tests that want the cached path flip this.
  const reportIsCached = vi.fn().mockReturnValue(false);
  const askCopilot = vi.fn().mockResolvedValue({ answer: "ok", relevantOfts: [] });
  vi.doMock("../services/sentinel.js", () => ({
    getWatched: vi.fn().mockResolvedValue([{ ticker: "MOFT", address: OFT, chainId: 14 }]),
    getWatchlistHealth: () => ({ degraded: false, reasons: [], lastRefreshAt: 1, servedStaleAt: null }),
  }));
  vi.doMock("../services/report.js", () => ({ generateReport, reportIsCached }));
  vi.doMock("../services/ask.js", () => ({ askCopilot }));

  const { router } = await import("../routes/sentinel.js");
  const app = express();
  app.use(express.json());
  app.use("/api/sentinel", router);
  server = app.listen(0);
  await new Promise((r) => server!.once("listening", r));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, generateReport, reportIsCached, askCopilot };
}

const getReport = (base: string, address = OFT) =>
  fetch(`${base}/api/sentinel/report/${address}`);

const ask = (base: string) =>
  fetch(`${base}/api/sentinel/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "what is at risk?" }),
  });

describe("GET /report/:address is rate limited", () => {
  it("serves the first ten requests from one IP", async () => {
    const { base, generateReport } = await startRouter();

    for (let i = 0; i < LIMIT; i++) expect((await getReport(base)).status).toBe(200);

    expect(generateReport).toHaveBeenCalledTimes(LIMIT);
  });

  it("answers 429 past the limit, with Retry-After, and never reaches the generator", async () => {
    const { base, generateReport } = await startRouter();

    for (let i = 0; i < LIMIT; i++) await getReport(base);
    const res = await getReport(base);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await res.json()).retryAfterSec).toBeGreaterThan(0);
    expect(generateReport).toHaveBeenCalledTimes(LIMIT); // the 11th spent no budget
  });

  it("spends a slot even for an address that is not watched", async () => {
    // The gate runs BEFORE the watchlist lookup on purpose: probing addresses to
    // find the watched ones must cost the same as asking for a real one, or the
    // limit is trivially side-stepped by walking the address space.
    const { base, generateReport } = await startRouter();

    for (let i = 0; i < LIMIT; i++) {
      expect((await getReport(base, "0x0000000000000000000000000000000000000001")).status).toBe(404);
    }

    expect((await getReport(base)).status).toBe(429);
    expect(generateReport).not.toHaveBeenCalled();
  });
});

describe("the report route and the copilot share one model budget", () => {
  it("reports consume the copilot's window, not a second one", async () => {
    const { base, askCopilot } = await startRouter();

    for (let i = 0; i < LIMIT; i++) expect((await getReport(base)).status).toBe(200);

    const res = await ask(base);
    expect(res.status).toBe(429);
    expect(askCopilot).not.toHaveBeenCalled();
  });

  it("copilot questions consume the report route's window too", async () => {
    const { base, generateReport } = await startRouter();

    for (let i = 0; i < LIMIT; i++) expect((await ask(base)).status).toBe(200);

    expect((await getReport(base)).status).toBe(429);
    expect(generateReport).not.toHaveBeenCalled();
  });

  it("reports the shared limit back to the copilot UI", async () => {
    const { base } = await startRouter();

    const body = await (await ask(base)).json();

    expect(body.limit).toBe(LIMIT);
    expect(body.remaining).toBe(LIMIT - 1);
  });
});

// The window's stated job is to protect the DeepSeek budget. A cached report costs
// nothing and used to cost a slot anyway, so re-reading the six reports this
// instance publishes could exhaust an hour's allowance without buying one token —
// most likely during judging, when opening every report is the obvious thing to do.
describe("a cached report costs no model spend, so it costs no slot", () => {
  it("serves cached reports past the limit and never calls the generator", async () => {
    const { base, generateReport, reportIsCached } = await startRouter();
    reportIsCached.mockReturnValue(true);

    for (let i = 0; i < LIMIT * 3; i++) expect((await getReport(base)).status).toBe(200);

    // Cached hits still call generateReport — it is the function that returns the
    // cached markdown. What they must NOT do is consume the window.
    expect(generateReport).toHaveBeenCalledTimes(LIMIT * 3);
  });

  it("leaves the whole window intact for the copilot", async () => {
    const { base, reportIsCached } = await startRouter();
    reportIsCached.mockReturnValue(true);

    for (let i = 0; i < LIMIT * 2; i++) expect((await getReport(base)).status).toBe(200);

    const body = await (await ask(base)).json();
    expect(body.remaining).toBe(LIMIT - 1);
  });

  it("still charges an uncached report, so the budget is genuinely protected", async () => {
    const { base, reportIsCached } = await startRouter();
    reportIsCached.mockReturnValue(false);

    for (let i = 0; i < LIMIT; i++) expect((await getReport(base)).status).toBe(200);

    expect((await getReport(base)).status).toBe(429);
  });

  it("still charges an unwatched address, so probing stays expensive", async () => {
    // The anti-enumeration property the old gate-first order bought. Discovering
    // which OFTs are watched must not be cheaper than asking for a real one, and
    // the cache check must not become a free 404 oracle.
    const { base, reportIsCached } = await startRouter();
    reportIsCached.mockReturnValue(true);

    const unwatched = "0x000000000000000000000000000000000000dead";
    for (let i = 0; i < LIMIT; i++) expect((await getReport(base, unwatched)).status).toBe(404);

    expect((await getReport(base, unwatched)).status).toBe(429);
  });
});
