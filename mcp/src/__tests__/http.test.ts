import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, SentinelApiError } from "../http.js";

describe("apiGet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed JSON from the API base", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      // Pinned: with no SENTINEL_API_URL set, this server reads THIS repository's
      // deployment. A default pointing at another instance answers confidently
      // about the wrong fleet.
      expect(String(url)).toBe("https://flare-sentinel-api-production.up.railway.app/api/sentinel/status");
      return new Response(JSON.stringify({ rulesVersion: "4.1.0" }), { status: 200 });
    }));
    await expect(apiGet("/api/sentinel/status")).resolves.toEqual({ rulesVersion: "4.1.0" });
  });

  it("throws SentinelApiError with status and backend error text on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Not a watched OFT" }), { status: 404 })));
    const err = await apiGet("/api/sentinel/report/0x00").catch((e) => e);
    expect(err).toBeInstanceOf(SentinelApiError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("Not a watched OFT");
  });

  it("wraps network failures in a SentinelApiError that names the fix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("boom"), { name: "TimeoutError" }); }));
    const err = await apiGet("/api/sentinel/status").catch((e) => e);
    expect(err).toBeInstanceOf(SentinelApiError);
    expect(err.message).toContain("SENTINEL_API_URL");
  });
});
