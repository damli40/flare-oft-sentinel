import { Router } from "express";
import type { Request, Response } from "express";
import { getWatched, getWatchlistHealth, pollOnce, runKelpReplay, runLibraryRevertReplay, runRpcConflictReplay, resetDemo } from "../services/sentinel.js";
import { getVerdicts, getSnapshot, latestVerdict, getScoreHistory, getFeedEvents } from "../services/snapshot-store.js";
import { assessSnapshot, RULES_VERSION } from "../services/drift.js";
import { generateReport } from "../services/report.js";
import { askCopilot } from "../services/ask.js";
import { loadDvnMeta, resolveDvn, dvnMetaHash, MetadataUnavailableError, type DvnMeta } from "../services/lz-config.js";
import { readFleetExposure, exposureKey } from "../services/exposure.js";
import { getChainRef, getChainRefByKey, chainDisplayName, sentinelChain, explorerBase } from "../services/chain-registry.js";
import { requireAdmin } from "./require-admin.js";
import type { CustodyDeclaration, Finding, OftSnapshot } from "../types.js";

export const router = Router();

// ── Operator-only routes ──────────────────────────────────────────────────────
// Every mutating route below that has no shipped UI caller carries requireAdmin.
// This backend is served on a public URL: /poll runs the real cycle (it signs
// from the attestor wallet and writes the on-chain registry), and the replay and
// reset routes mutate the server-side demo state a viewer is looking at. Without
// ADMIN_TOKEN set they answer 404 — the route does not exist. The operator's
// filmed poll is a curl with the token; the in-process scheduled poller never
// passes through here, so its behaviour is unchanged.
//
// Deliberately NOT gated: POST /ask (UI-called, rate-limited), POST /validate
// (read-only rule engine, MCP surface), and every GET.


// ── Model-budget rate limiting ────────────────────────────────────────────────
// IP-based sliding window: 10 model-backed requests per hour per IP. Protects the
// DeepSeek budget if the demo gets shared publicly; a cached answer or report
// still consumes a slot (the limit is on requests, the cache is on LLM spend).
//
// TWO routes reach the model — POST /ask and GET /report/:address — and they
// share ONE window rather than getting one each. The thing being protected is a
// single budget, so a second window would simply double what one IP can spend.
// /report had no limit at all until now: no auth, no window, and cached only per
// snapshot, so repeat hits on ONE address were free but a walk through many
// addresses was not.
const MODEL_LIMIT = 10;
const MODEL_WINDOW_MS = 60 * 60_000;
const ASK_MAX_QUESTION_CHARS = 500;
const modelHits = new Map<string, number[]>();

function modelRateCheck(ip: string): { ok: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const hits = (modelHits.get(ip) ?? []).filter((t) => now - t < MODEL_WINDOW_MS);
  if (hits.length >= MODEL_LIMIT) {
    modelHits.set(ip, hits);
    return { ok: false, remaining: 0, retryAfterSec: Math.ceil((hits[0] + MODEL_WINDOW_MS - now) / 1000) };
  }
  hits.push(now);
  modelHits.set(ip, hits);
  return { ok: true, remaining: MODEL_LIMIT - hits.length, retryAfterSec: 0 };
}

/** Consume a slot for this request. Returns the remaining count, or null after it
 *  has already answered 429 — a caller with nothing to add just returns on null.
 *  One helper so the two routes cannot drift apart in what they enforce. */
function modelRateGate(req: Request, res: Response): number | null {
  const rate = modelRateCheck(req.ip ?? "unknown");
  if (rate.ok) return rate.remaining;
  res.setHeader("Retry-After", String(rate.retryAfterSec));
  res.status(429).json({
    error: `Community tier limit reached (${MODEL_LIMIT} requests/hour). Try again in ${Math.max(1, Math.ceil(rate.retryAfterSec / 60))} min.`,
    retryAfterSec: rate.retryAfterSec,
  });
  return null;
}

// GET /api/sentinel/report/:address — full markdown audit report for one watched OFT.
// Rate-limited on the shared model window above: report generation calls DeepSeek.
router.get("/report/:address", async (req: Request, res: Response) => {
  // Gate first, before the watchlist read. A slot is spent whatever the address
  // turns out to be, so probing addresses to find the watched ones costs the same
  // as asking for a real one.
  if (modelRateGate(req, res) === null) return;
  const addr = String(req.params.address).toLowerCase();
  const w = (await getWatched()).find((x) => x.address.toLowerCase() === addr);
  if (!w) {
    res.status(404).json({ error: "Not a watched OFT" });
    return;
  }
  try {
    const markdown = await generateReport(w);
    if (!markdown) {
      res.status(425).json({ error: "Not polled yet — try again shortly" });
      return;
    }
    res.json({ ticker: w.ticker, markdown });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sentinel/status — watched OFTs + their latest snapshot, current risk
// posture (assessSnapshot on the live snapshot — display only, no on-chain action),
// and their latest drift verdict (the attested one).
router.get("/status", async (_req: Request, res: Response) => {
  // A metadata blackout must not blank the dashboard. A 503 renders as "site broken",
  // which reads to an operator as a deploy problem rather than "monitoring has stopped" —
  // and stale tiles with no marker read as "everything is fine", which is the same class
  // of bug (absence displayed as safety) that the per-chain dead-DVN fix exists to kill.
  // Serve the tiles, stamp the response, let the UI grey them out.
  let dvnMeta: DvnMeta;
  let list: Awaited<ReturnType<typeof getWatched>>;
  try {
    [list, dvnMeta] = await Promise.all([getWatched(), loadDvnMeta()]);
  } catch (e) {
    if (e instanceof MetadataUnavailableError) {
      return res.status(200).json({
        watched: [], chains: [], msi: null,
        msiBreakdown: { critical: 0, atRisk: 0, safe: 0, unassessed: 0 },
        registry: process.env.AUDIT_REGISTRY_ADDRESS,
        alertBus: process.env.ALERT_BUS_ADDRESS,
        chain: sentinelChain(),
        rulesVersion: RULES_VERSION,
        degraded: { reason: "dvn_metadata_unavailable", detail: e.message, since: Date.now() },
      });
    }
    throw e;
  }
  // What each watched asset is worth at the price the enshrined oracle last
  // published. This is a SEPARATE read from everything below it and it is
  // deliberately awaited before the verdicts are built rather than inside them:
  // readFleetExposure absorbs its own failures and answers with an empty map, so
  // there is no path from a price read to a missing verdict. A row that is not in
  // the map serves `exposure: null`, which the page states as "not read this
  // cycle" — never as zero.
  //
  // Nothing below reads it. The score is computed by the rule engine from the
  // config snapshot alone, and a price is not one of its inputs.
  const exposures = await readFleetExposure(list);
  const watched = await Promise.all(list.map(async (w) => {
    const snap = getSnapshot(w.address, w.chainId);
    const a = snap ? await assessSnapshot(snap, w.ticker) : null;
    // A DVN's identity is the (chainKey, address) pair. Send-side DVNs live on the OFT's
    // OWN chain — resolving them against a hardcoded "mantle" gave every Ethereum and Base
    // asset the wrong DVN names (same bug drift.ts fixed in rules 2.1.0). Unknown chain →
    // resolveDvn returns an address fragment, never a name borrowed from another chain.
    const srcChainKey = getChainRef(w.chainId)?.chainKey ?? null;
    // Per-corridor DVN breakdown: one entry per active route, null when ULN is unreadable.
    // The message libraries sit OUTSIDE the uln object on purpose: they are read from the
    // endpoint, not from the ULN, so they survive an unreadable ULN. Each is null when the
    // read itself failed — a consumer must render nothing rather than a placeholder, since
    // a placeholder for an unread library is absence displayed as a value (see the note at
    // the top of this handler).
    const activeRoutes = snap?.routes.filter(r => r.isActive) ?? [];
    const dvnCorridors = activeRoutes.length > 0
      ? activeRoutes.map(r => {
          const libs = {
            sendLibrary: r.sendLibrary,
            sendLibIsDefault: r.sendLibIsDefault,
            receiveLibrary: r.receiveLibrary,
            receiveLibIsDefault: r.receiveLibIsDefault,
          };
          if (!r.uln) return { corridor: r.chainName, eid: r.eid, ...libs, uln: null };
          const names = Object.fromEntries(
            [...r.uln.requiredDVNs, ...r.uln.optionalDVNs].map(addr => [addr, resolveDvn(addr, srcChainKey, dvnMeta)])
          );
          return {
            corridor: r.chainName,
            eid: r.eid,
            ...libs,
            uln: {
              confirmations: r.uln.confirmations,
              requiredCount: r.uln.requiredDVNCount,
              optionalThreshold: r.uln.optionalDVNThreshold,
              effectiveCount: r.uln.requiredDVNCount + (r.uln.optionalDVNThreshold ?? 0),
              requiredDVNs: r.uln.requiredDVNs,
              optionalDVNs: r.uln.optionalDVNs,
              names,
            },
          };
        })
      : null;
    // dvnSummary: first corridor with a readable ULN (for backward-compat summary panels).
    const firstReadable = activeRoutes.find(r => r.uln !== null);
    const firstUln = firstReadable?.uln ?? null;
    const dvnSummary = firstUln ? {
      requiredCount: firstUln.requiredDVNCount,
      optionalThreshold: firstUln.optionalDVNThreshold,
      effectiveCount: firstUln.requiredDVNCount + (firstUln.optionalDVNThreshold ?? 0),
      requiredDVNs: firstUln.requiredDVNs,
      optionalDVNs: firstUln.optionalDVNs,
    } : null;
    const dvnNames = firstUln ? Object.fromEntries(
      [...firstUln.requiredDVNs, ...firstUln.optionalDVNs].map((addr) => [addr, resolveDvn(addr, srcChainKey, dvnMeta)])
    ) : null;
    return {
      ...w,
      lastSnapshotAt: snap?.capturedAt ?? null,
      corridors: activeRoutes.map(r => r.chainName),
      assessment: a ? {
        score: a.score,
        riskLevel: a.riskLevel,
        reasons: a.findings.filter(f => f.severity !== "PASS").map(f => f.detail),
        tis: a.tis,
      } : null,
      latestVerdict: latestVerdict(w.address, w.chainId),
      dvnSummary,
      dvnNames,
      dvnCorridors,
      // Optional and absent-safe: an older stored snapshot, or an instance whose
      // price read failed, carries null here and the page renders that as
      // unread. No existing field's meaning or type changes.
      exposure: exposures.get(exposureKey(w.chainId, w.address)) ?? null,
    };
  }));

  // Distinct chains actually watched, biggest fleet first. This is THE source the
  // frontend renders chain names, fleet tabs, and hero/footer copy from — adding a
  // chain to the registry + watchlist updates the whole UI with zero frontend edits.
  const chainCounts = new Map<number, number>();
  for (const w of watched) chainCounts.set(w.chainId, (chainCounts.get(w.chainId) ?? 0) + 1);
  const chains = [...chainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([chainId, count]) => {
      const key = getChainRef(chainId)?.chainKey ?? null;
      // explorer is null for chains we have no verified explorer for; the UI
      // renders a plain address rather than guessing a URL.
      return {
        chainId, chainKey: key, count,
        name: key ? chainDisplayName(key) : `Chain ${chainId}`,
        explorer: explorerBase(chainId),
      };
    });

  // Mantle Security Index: unweighted average of all assessed scores (0–100).
  // DEMO is synthetic (replay-only) — it must never move the fleet index.
  const real = watched.filter((w) => w.ticker !== "DEMO");
  const assessed = real.filter((w) => w.assessment !== null);
  const msi = assessed.length > 0
    ? Math.round(assessed.reduce((s, w) => s + w.assessment!.score, 0) / assessed.length)
    : null;
  const msiBreakdown = {
    critical: real.filter((w) => w.assessment?.riskLevel === "CRITICAL").length,
    atRisk: real.filter((w) => w.assessment?.riskLevel === "AT_RISK").length,
    safe: real.filter((w) => w.assessment?.riskLevel === "PASS").length,
    unassessed: real.length - assessed.length,
  };

  // Metadata provenance, mirrored from the PDR. `stale` when we are serving a cached DVN
  // table because the live fetch failed — verdicts are still real, just computed against
  // an older ground truth. The hash lets a reader confirm which one.
  const metaAgeMs = Date.now() - dvnMeta.fetchedAt;
  res.json({
    watched,
    chains,
    msi,
    msiBreakdown,
    registry: process.env.AUDIT_REGISTRY_ADDRESS,
    alertBus: process.env.ALERT_BUS_ADDRESS,
    // Which chain this instance's contracts live on, and where to link them.
    // Served so the UI stops hardcoding an explorer that is right for exactly
    // one deployment and 404s for every other.
    chain: sentinelChain(),
    rulesVersion: RULES_VERSION,
    dvnMeta: {
      hash: dvnMetaHash(dvnMeta),
      fetchedAt: dvnMeta.fetchedAt,
      stale: metaAgeMs > 24 * 3600_000,
    },
    // Watchlist provenance, same contract as dvnMeta: tiles keep rendering during a
    // Dune outage, but the response says the fleet list is degraded/stale so the UI
    // can mark reduced coverage instead of displaying absence as safety.
    watchlist: getWatchlistHealth(),
  });
});

// GET /api/sentinel/verdicts — full attestation history.
router.get("/verdicts", (_req: Request, res: Response) => {
  res.json({ verdicts: getVerdicts() });
});

// ── POST /api/sentinel/validate — the rule engine as a PURE function ────────
// Pre-flight check for proposed or existing configs (the MCP validate_config
// tool rides this). Runs assessSnapshot on the submitted snapshot ONLY: no
// attestation, no alert, no snapshot/verdict storage — same request, same
// response, regardless of server state. Custody comes from the request or is
// explicitly none; the operator's declarations store is never consulted, so a
// public caller can't inherit declarations for an address they don't control.
const VALIDATE_MAX_ROUTES = 30;
const VALIDATE_CUSTODY_TYPES = new Set(["eoa_hot", "fireblocks_mpc", "safe_multisig", "unknown"]);
const VALIDATE_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ── x402 challenge (OKX Agent Payments Protocol) ─────────────────────────────
// OKX's escrow probes this endpoint expecting an HTTP 402 challenge even at
// fee 0 — without one it falls back to direct-accept and the task dies waiting
// for a result that x402 would have taken from the HTTP response itself. The
// challenge advertises the listed terms of agent #6455: 0.01 USDT on X Layer.
// The fee is nonzero because OKX's buyer-side task-402-pay cannot convert a
// zero amount to minimal units ("expected 0 USDT ≈ ?", their Jul 21 report) —
// a zero-amount challenge passes their x402-check but fails every real paid
// replay. This amount MUST match the listed service fee or the buyer's
// amount check rejects the challenge.
// Requests carrying an x402 payment header, or any request with a snapshot
// body, still get the verdict; only unpaid snapshot-less requests see the 402.
// The accepts entry declares its own input shape (`outputSchema.input`): buyer
// CLIs attach only parameters the seller declares and never invent a request
// body, so without it a paid replay arrives empty and the buyer pays for the
// usage hint instead of a verdict (caught in the Jul 24 paid self-test).
// `ticker` is required rather than optional because an unsupplied optional
// param is dropped by the buyer — required makes the CLI collect it first.
const X402_RESOURCE_URL =
  process.env.PUBLIC_VALIDATE_URL ?? "https://backend-production-d16e.up.railway.app/api/sentinel/validate";
const X402_CHALLENGE = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: X402_RESOURCE_URL,
      // OKX specs no machine-readable input schema anywhere (the A2MCP guide's
      // challenge has no schema field; ASP registration takes only name /
      // description / price / endpoint), so this prose IS the interface
      // contract a buying agent reads before composing its request.
      description:
        "OFT Config Validation — deterministic LayerZero OFT verdict with findings. POST { \"ticker\": \"USDe\" } for a monitored token's latest verdict on every chain it runs on (add \"chainId\" to narrow), or POST { \"snapshot\": { \"routes\": [...] } } to score a config directly. An empty body returns the whole monitored fleet.",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:196",
        asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT (USD₮0) on X Layer
        // OKX's x402-check can't resolve this asset's decimals from its own
        // token list and asks for a `decimals` field in the accepts entry.
        decimals: 6,
        amount: "10000", // 0.01 USDT — keep in lockstep with the listed service fee
        payTo: "0xd2e640e2ff4d9693f1c8000bbcc10a8de76c0e7d", // agent #6455 owner wallet
        maxTimeoutSeconds: 300, // canonical value from OKX's A2MCP guide example
        extra: { assetSymbol: "USDT", assetDecimals: 6, assetTransferMethod: "eip3009", name: "USD₮0", version: "1" },
        outputSchema: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              type: "object",
              required: ["ticker"],
              properties: {
                ticker: {
                  type: "string",
                  description: "Token symbol to check, e.g. USDe. Returns the latest verdict for every monitored chain it is deployed on.",
                },
                chainId: {
                  type: "integer",
                  description: "Optional. Narrows a multi-chain token to one chain, given as a numeric chain id.",
                },
              },
            },
          },
        },
      },
    ],
  }),
).toString("base64");

// ── X402_ENABLED — the challenge is per-instance, not per-codebase ───────────
//
// The 402 above is the agent-payments listing of ONE deployment. Every other
// instance inherits the code and answers 402 to a bare GET, which on a public
// instance reads as a paywall on a free tool. The Flare instance is the case
// that made this concrete: its /validate is free, its readers are judges, and
// the challenge it served advertised a resource URL on a different host.
//
// So the challenge is opt-IN by absence of an explicit "false": unset keeps the
// listed deployment behaving exactly as it did, and `X402_ENABLED=false` turns
// it off for everyone else. Exact-string comparison, like ALERTS_DISABLED — a
// typo must not silently disable a live payment path.
//
// Nothing about this could be a Flare-priced challenge today. Flare's own x402
// guide (dev.flare.network/fxrp/token-interactions/x402-payments) targets
// Coston2 testnet with a MockUSDT0 it has you deploy yourself, because the
// scheme needs EIP-3009 `transferWithAuthorization` and the doc states FXRP will
// be supported "once it implements" it. Measured on Flare Mainnet 2026-08-08:
// neither USDT0 (0x5672…7588) nor FXRP (0xd706…e07e) exposes
// transferWithAuthorization, receiveWithAuthorization, authorizationState or
// DOMAIN_SEPARATOR — every one reverts. There is no asset to price it in.
const X402_ENABLED = process.env.X402_ENABLED !== "false";

const VALIDATE_USAGE = {
  endpoint: "POST /api/sentinel/validate",
  body: "{ snapshot, ticker?, custodyDeclaration? }  (a config at the body root also works)",
  returns: "score, riskLevel, rulesVersion, findings[], tis[] — the rule engine as a pure function",
  writes: "nothing: no attestation, no alert, no stored state, and the custody store is never read",
  cost: "free",
};

function sendX402Challenge(res: Response): void {
  if (!X402_ENABLED) {
    // Not a payment wall and not an error: the caller asked what this endpoint
    // wants, so answer that.
    res.status(200).json(VALIDATE_USAGE);
    return;
  }
  res.status(402).set("PAYMENT-REQUIRED", X402_CHALLENGE).json({
    error: "Payment required",
    hint: "POST { snapshot, ticker?, custodyDeclaration? } — a valid snapshot body or an x402 payment header unlocks the verdict",
  });
}

// GET /api/sentinel/validate — x402 discovery probe (OKX checks GET first).
// A PAID GET must get a deliverable, never another challenge: the OKX buyer
// CLI replays with the method it probed with (GET), and an unconditional 402
// here strands the payment as "facilitator non-terminal" (caught live in the
// Jul 21 buyer-flow self-test). The config itself can only ride a POST body,
// so the paid-GET deliverable is the plain-language usage answer.
router.get("/validate", async (req: Request, res: Response) => {
  if (req.headers["payment-signature"] || req.headers["x-payment"]) {
    // A GET carries no body, so it can never name an asset — serve the fleet.
    try {
      await sendFleetCache(res);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
    return;
  }
  sendX402Challenge(res);
});

// ── /validate input normalizer ──────────────────────────────────────────────
// OKX's escrow re-test (Jul 21) paid the x402 challenge and then died one layer
// deeper: buyers paste configs as humans hold them — ticker, routes with chain
// names, DVN lists, confirmations, no contract address — and the old parser
// hard-400'd anything without snapshot.oft. The engine never needed that gate:
// /validate bypasses the custody store (the only consumer of snapshot.oft) and
// treats every absent field as "unknown, never scored". The parser now matches
// the engine's tolerance: identity fields are optional and their absence
// becomes an UNVERIFIABLE advisory in the findings; routes may name their
// destination chain instead of carrying an eid; flat dvns/confirmations lift
// into the ULN shape. When nothing is scoreable at all the answer is still
// HTTP 200 with a plain-language explanation, so an agent buyer always has a
// deliverable for its user — never a raw 400.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function stringArray(...cands: unknown[]): string[] | null {
  for (const c of cands) {
    if (Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === "string")) return c as string[];
  }
  return null;
}

function findAddress(s: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = s[k];
    if (typeof v === "string" && VALIDATE_ADDR_RE.test(v)) return v;
  }
  return null;
}

function sendIncomplete(res: Response, missing: string[], message: string): void {
  res.json({ score: null, riskLevel: null, incomplete: true, missing, message, rulesVersion: RULES_VERSION });
}

// ── /validate ticker cache lookup ───────────────────────────────────────────
// A paying buyer who already holds the full route/DVN snapshot has done the
// hard part themselves — the listed promise of agent #6455 is address-in,
// verdict-out. A paid { ticker } body answers from the watchlist's hourly-poll
// cache. No live on-chain read on the request path: its ~900s worst-case tail
// would blow the 300s payment window.
const TICKER_STALE_MS = 2 * 3_600_000; // poller missed at least one hourly cycle

async function cachedResult(w: { ticker: string; address: string; chainId: number }): Promise<Record<string, unknown>> {
  const snap = getSnapshot(w.address, w.chainId);
  if (!snap) {
    return { ticker: w.ticker, chainId: w.chainId, oft: w.address, incomplete: true, message: "This token is monitored but not yet polled — try again shortly." };
  }
  const { findings, score, riskLevel, tis } = await assessSnapshot(snap, w.ticker, null);
  const ageMs = Date.now() - snap.capturedAt;
  const stale = ageMs > TICKER_STALE_MS;
  const out: Finding[] = [...findings];
  // A silent stale PASS on a config-drift tool is the one failure mode that
  // can't ship — staleness is always surfaced, never withheld.
  if (stale) {
    out.push({
      severity: "UNKNOWN",
      evidence: "unverifiable",
      check: "Verdict freshness",
      detail: `This verdict was captured ${Math.round(ageMs / 3_600_000)} hours ago from the last poll; the live config may have changed since. Re-check if freshness matters.`,
    });
  }
  return { ticker: w.ticker, chainId: w.chainId, oft: w.address, score, riskLevel, findings: out, tis, rulesVersion: RULES_VERSION, asOf: snap.capturedAt, ageMs, stale };
}

async function lookupTickerCache(res: Response, ticker: string, chainId: number | null): Promise<void> {
  const watched = await getWatched();
  const t = ticker.toLowerCase();
  const matches = watched.filter((w) => w.ticker.toLowerCase() === t && (chainId == null || w.chainId === chainId));
  if (matches.length === 0) {
    sendIncomplete(res, ["ticker"], `"${ticker}" is not on the monitored watchlist, so there is no cached verdict for it. Send the LayerZero config itself as JSON — { snapshot: { routes: [{ chainName or eid, dvns: [...], confirmations }] } } — for a direct verdict.`);
    return;
  }
  res.json({ ticker, source: "cache", results: await Promise.all(matches.map(cachedResult)) });
}

// A buyer who paid without naming an asset must never get a usage hint for
// their money. OKX's spec carries no machine-readable input schema — the A2MCP
// guide's challenge has no schema field and ASP registration takes only name /
// description / price / endpoint, so the buying agent composes the request from
// prose and some buyers will always arrive with an empty body. The widest
// honest answer to "what do you know?" is the whole monitored fleet; it is the
// same data /status already serves publicly, so nothing new is disclosed.
async function sendFleetCache(res: Response): Promise<void> {
  const watched = await getWatched();
  res.json({
    source: "cache",
    scope: "fleet",
    message: "No asset was named, so this is every OFT currently monitored, with its latest verdict. To check one, POST { ticker: \"USDe\" } — add chainId to narrow a multi-chain token. To score a config that is not monitored, POST { snapshot: { routes: [...] } }.",
    results: await Promise.all(watched.map(cachedResult)),
  });
}

router.post("/validate", async (req: Request, res: Response) => {
  const bad = (error: string) => res.status(400).json({ error });
  const body = isObj(req.body) ? (req.body as Record<string, unknown>) : {};
  const paid = Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);
  let s = isObj(body.snapshot) ? (body.snapshot as Record<string, unknown>) : null;
  // Config pasted at the body root, without the { snapshot } wrapper.
  if (!s && (Array.isArray(body.routes) || Array.isArray(body.dvns) || Array.isArray(body.requiredDVNs))) s = body;
  if (!s) {
    // Snapshot-less and unpaid = an x402 probe, not a malformed API call.
    if (!paid) {
      sendX402Challenge(res);
      return;
    }
    // Paid and config-less but named a ticker → the cached verdict path.
    const ticker = typeof body.ticker === "string" ? body.ticker.trim() : "";
    if (ticker) {
      let cid: number | null = typeof body.chainId === "number" && Number.isInteger(body.chainId) ? body.chainId : null;
      if (cid === null && typeof body.chainId === "string" && /^\d+$/.test(body.chainId)) cid = parseInt(body.chainId, 10);
      try {
        await lookupTickerCache(res, ticker, cid);
      } catch (e: any) {
        if (e instanceof MetadataUnavailableError) {
          res.status(503).json({ error: "DVN metadata unavailable — try again shortly" });
          return;
        }
        res.status(500).json({ error: e.message });
      }
      return;
    }
    // Paid, but nothing named: answer with the whole fleet rather than a hint.
    try {
      await sendFleetCache(res);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  const advisories: Finding[] = [];
  const advise = (check: string, detail: string) =>
    advisories.push({ severity: "UNKNOWN", evidence: "unverifiable", check, detail });

  const oft = findAddress(s, ["oft", "address", "tokenAddress", "contractAddress", "contract", "token"]);
  if (!oft) {
    advise("Input: OFT address", "No OFT contract address was provided, so this verdict covers the pasted configuration only — it is not tied to any on-chain deployment. Include the token's 0x… contract address (snapshot.oft) to get a verdict that can be checked against live chain state.");
  }

  let chainId: number | null = typeof s.chainId === "number" && Number.isInteger(s.chainId) ? s.chainId : null;
  if (chainId === null && typeof s.chainId === "string" && /^\d+$/.test(s.chainId)) chainId = parseInt(s.chainId, 10);
  if (chainId === null) {
    for (const k of ["chainKey", "chainName", "chain", "sourceChain"]) {
      const v = s[k];
      const ref = typeof v === "string" ? getChainRefByKey(v.trim().toLowerCase()) : null;
      if (ref) {
        chainId = ref.chainId;
        break;
      }
    }
  }
  if (chainId === null) {
    advise("Input: source chain", 'The config did not say which chain it lives on. Structural checks (DVN quorum, confirmations, library pinning) still ran, but DVN addresses could not be resolved to named operators, so deprecation and self-DVN checks were skipped. Add chainId or a chain name like "ethereum".');
  }

  const topDvns = stringArray(s.dvns, s.requiredDVNs);
  const topConf = typeof s.confirmations === "number" && Number.isInteger(s.confirmations) ? s.confirmations : null;
  let rawRoutes: unknown[] = Array.isArray(s.routes) ? s.routes : [];
  if (rawRoutes.length === 0 && (topDvns || topConf !== null)) {
    rawRoutes = [{}];
    advise("Input: routes", "No per-route breakdown was provided; the top-level DVN and confirmation settings were validated as a single route with an unknown destination. LayerZero security config is set per destination chain — send a routes array for a per-corridor verdict.");
  }
  const routeObjs = rawRoutes.filter(isObj);
  if (routeObjs.length === 0) {
    sendIncomplete(res, ["routes"], "Nothing to validate: the config contained no routes and no DVN settings. Send at least one route — { chainName (or eid), dvns: [...], confirmations } — or a full snapshot from a config read. Fields you leave out are treated as unknown, never scored against you.");
    return;
  }
  if (routeObjs.length > VALIDATE_MAX_ROUTES) {
    bad(`too many routes (${routeObjs.length}) — max ${VALIDATE_MAX_ROUTES} per validation`);
    return;
  }
  let custody: CustodyDeclaration | null = null;
  const cd = body?.custodyDeclaration as Record<string, unknown> | undefined;
  if (cd !== undefined) {
    if (!cd || typeof cd !== "object" || !VALIDATE_CUSTODY_TYPES.has(String(cd.custodyType)) || typeof cd.declaredBy !== "string") {
      bad(`custodyDeclaration must be { custodyType: ${[...VALIDATE_CUSTODY_TYPES].join(" | ")}, declaredBy }`);
      return;
    }
    custody = {
      custodyType: cd.custodyType as CustodyDeclaration["custodyType"],
      declaredBy: cd.declaredBy,
      declaredAt: typeof cd.declaredAt === "string" ? cd.declaredAt : new Date().toISOString().slice(0, 10),
      verified: false,
    };
  }
  // Missing optional fields become null — the engine already treats null as
  // "unknown, never scored", so a partial agent-built config validates on
  // exactly what it asserts.
  const routeDefaults = {
    chainKey: null, sendLibrary: null, sendLibIsDefault: null, receiveLibrary: null,
    receiveLibIsDefault: null, uln: null, receiveUln: null, peer: null, peerAddress: null,
    hasEnforcedOptions: null, isActive: true,
  };
  let unknownDest = 0;
  const routes = routeObjs.map((r, i) => {
    let eid = typeof r.eid === "number" && Number.isInteger(r.eid) ? r.eid : null;
    const named = ["chainKey", "chainName", "chain", "to", "destination"]
      .map((k) => r[k])
      .find((v) => typeof v === "string" && v !== "") as string | undefined;
    if (eid === null && named) eid = getChainRefByKey(named.trim().toLowerCase())?.eid ?? null;
    if (eid === null) {
      unknownDest++;
      eid = 0; // 0 = destination not identified; structural checks still run
    }
    let uln = isObj(r.uln) ? (r.uln as Record<string, unknown>) : null;
    if (uln && Array.isArray(uln.requiredDVNs) && typeof uln.requiredDVNCount !== "number") {
      uln = { ...uln, requiredDVNCount: uln.requiredDVNs.length };
    }
    if (!uln) {
      const dvns = stringArray(r.dvns, r.requiredDVNs) ?? topDvns;
      const conf = typeof r.confirmations === "number" && Number.isInteger(r.confirmations) ? r.confirmations : topConf;
      if (dvns) {
        // confirmations 0 = "not asserted" in the engine's convention — never scored.
        uln = { confirmations: conf ?? 0, requiredDVNCount: dvns.length, requiredDVNs: dvns, optionalDVNCount: 0, optionalDVNThreshold: 0, optionalDVNs: [] };
      }
    }
    const libs = isObj(r.libraries) ? (r.libraries as Record<string, unknown>) : null;
    return {
      ...routeDefaults,
      ...r,
      eid,
      uln,
      sendLibrary: typeof r.sendLibrary === "string" ? r.sendLibrary : typeof libs?.send === "string" ? libs.send : null,
      receiveLibrary: typeof r.receiveLibrary === "string" ? r.receiveLibrary : typeof libs?.receive === "string" ? libs.receive : null,
      chainName: typeof r.chainName === "string" && r.chainName !== "" ? r.chainName : named ?? (eid !== 0 ? `eid-${eid}` : `route-${i + 1}`),
    };
  });
  if (unknownDest > 0) {
    advise("Input: destination chains", `${unknownDest} route${unknownDest > 1 ? "s" : ""} did not name a destination this service recognizes. Their DVN and confirmation settings were still checked structurally, but cross-referencing against known chain deployments was skipped. Use a LayerZero eid or a chain name like "ethereum".`);
  }
  const snapshot = {
    owner: null, ownerIsContract: null, proxyAdmin: null, proxyAdminOwner: null,
    proxyAdminIsMultisig: null, proxyAdminOwnerIsContract: null,
    ...s,
    oft,
    chainId: chainId ?? 0,
    capturedAt: typeof s.capturedAt === "number" ? s.capturedAt : Date.now(),
    routes,
  } as unknown as OftSnapshot;
  try {
    const { findings, score, riskLevel, tis } = await assessSnapshot(
      snapshot,
      typeof body?.ticker === "string" ? body.ticker : undefined,
      custody,
    );
    res.json({ score, riskLevel, findings: [...findings, ...advisories], tis, rulesVersion: RULES_VERSION });
  } catch (e: any) {
    if (e instanceof MetadataUnavailableError) {
      res.status(503).json({ error: "DVN metadata unavailable — try again shortly" });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/poll — run one live poll across all watched OFTs now.
// Operator-only: this is the path that reaches attest() and dispatchAlert().
router.post("/poll", requireAdmin, async (_req: Request, res: Response) => {
  try {
    await pollOnce();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/replay-kelp — the demo: seed healthy → inject 1-of-1 →
// verdict flips CRITICAL. Whether that verdict is then written on-chain is not
// this route's decision: it goes through the same attest gate as a real poll
// (attestInScope in attestor.ts), so an instance whose ATTEST_PINNED does not
// list the demo asset flips the verdict and signs nothing. The chain written to
// is whichever one SENTINEL_CHAIN_ID names, never a fixed one.
router.post("/replay-kelp", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const verdict = await runKelpReplay();
    res.json({ ok: true, verdict });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/replay-library-revert — demo: seed healthy (pinned libs) →
// inject snapshot where receive library reverted to default → CRITICAL verdict.
router.post("/replay-library-revert", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const verdict = await runLibraryRevertReplay();
    res.json({ ok: true, verdict });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/replay-rpc-conflict — demo: seed healthy baseline →
// inject snapshot where secondary RPC disagrees on DVN config → CRITICAL verdict.
router.post("/replay-rpc-conflict", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const verdict = await runRpcConflictReplay();
    res.json({ ok: true, verdict });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sentinel/history/:address — score history for one watched OFT.
//
// The chain id must be the one the asset is actually watched on. Score history is
// keyed `chainId:address` (snapshot-store.ts:30) and WRITTEN with `w.chainId`
// (sentinel.ts:247), but this read used a hardcoded MANTLE_CHAIN_ID. On any
// instance that is not Mantle the two keys can never meet, so every history and
// every sparkline came back empty — silently, and looking exactly like "we have
// no data yet" rather than a bug.
router.get("/history/:address", async (req: Request, res: Response) => {
  const addr = String(req.params.address).toLowerCase();
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  // Resolve the chain from the watchlist. An explicit ?chainId= wins, which is
  // the only way to disambiguate one address deployed on several chains.
  const watched = await getWatched();
  const matches = watched.filter((w) => w.address.toLowerCase() === addr);
  // A junk ?chainId= used to become NaN, serialise as `chainId: null` and return
  // an empty history — indistinguishable from "this address is not watched". Bad
  // input gets an error, not a plausible-looking empty answer.
  let requested: number | null = null;
  if (req.query.chainId != null) {
    requested = Number(req.query.chainId);
    if (!Number.isInteger(requested) || requested <= 0) {
      res.status(400).json({ error: "chainId must be a positive integer" });
      return;
    }
  }
  const chainId = requested ?? matches[0]?.chainId ?? null;
  if (chainId === null) return res.json({ oft: addr, chainId: null, history: [] });
  res.json({ oft: addr, chainId, history: getScoreHistory(addr, chainId, limit) });
});

// GET /api/sentinel/feed — time-ordered security event stream.
router.get("/feed", (_req: Request, res: Response) => {
  const events = getFeedEvents(40);
  res.json({ events });
});

// POST /api/sentinel/ask — Security Copilot: natural language queries over fleet data.
// Rate-limited on the shared model window (10/hour/IP), input-capped (500 chars);
// answers cached in ask.ts.
router.post("/ask", async (req: Request, res: Response) => {
  const question = req.body?.question as string;
  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  if (question.length > ASK_MAX_QUESTION_CHARS) {
    res.status(400).json({ error: `Question too long (max ${ASK_MAX_QUESTION_CHARS} characters)` });
    return;
  }
  const remaining = modelRateGate(req, res);
  if (remaining === null) return;
  try {
    const result = await askCopilot(question);
    res.json({ ...result, remaining, limit: MODEL_LIMIT });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sentinel/reset-demo — re-seed the DEMO OFT's healthy 2-of-2 baseline
// so the before→after of the next replay is visible in the fleet grid.
router.post("/reset-demo", requireAdmin, (_req: Request, res: Response) => {
  resetDemo();
  res.json({ ok: true });
});

// GET /api/sentinel/history — score history for every watched OFT in one call
// (fleet-grid sparklines). Keyed by lowercase address.
router.get("/history", async (_req: Request, res: Response) => {
  const watched = await getWatched();
  const histories = Object.fromEntries(
    // w.chainId, not a constant: this is the same key the write side uses.
    watched.map((w) => [w.address.toLowerCase(), getScoreHistory(w.address, w.chainId, 60)])
  );
  res.json({ histories });
});
