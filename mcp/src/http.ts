// Thin HTTP client over the Sentinel backend. Read-only by construction:
// apiGet everywhere except the one pure /validate endpoint (apiPost).
// Default: this repository's own deployment, the Flare instance. Point
// SENTINEL_API_URL at another one to read a different fleet.
const BASE = process.env.SENTINEL_API_URL ?? "https://flare-sentinel-api-production.up.railway.app";

export class SentinelApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "SentinelApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e: any) {
    throw new SentinelApiError(
      `Sentinel API unreachable (${e?.name ?? "fetch failed"}) — check network or the SENTINEL_API_URL env override`,
    );
  }
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = (JSON.parse(body) as { error?: string }).error ?? detail;
    } catch { /* non-JSON error body — keep the raw slice */ }
    throw new SentinelApiError(`Sentinel API ${res.status}: ${detail}`, res.status);
  }
  return JSON.parse(body) as T;
}

export const apiGet = <T>(path: string): Promise<T> => request<T>(path);
export const apiPost = <T>(path: string, json: unknown): Promise<T> =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json),
  });
