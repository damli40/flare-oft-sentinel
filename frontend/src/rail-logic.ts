// ── The rail page's pure logic, lifted out of the component so it can be tested
//
// Everything here is a total function of its arguments: no React, no DOM, no
// fetch, no clock. It lives in its own file for one reason — the judge page's
// non-obvious decisions (which corridors survive a failed read, when a recorded
// verdict stops being evidence, what the tile is allowed to claim about a DVN
// quorum, where the open panel goes in the grid) were each proved once with a
// throwaway fixture and then had nothing standing behind them. Two of them had
// already shipped wrong once.
//
// The tests are in `backend/src/__tests__/rail-logic.test.ts`. They run in the
// backend vitest project rather than a new frontend runner, the same way
// `chain-consistency.test.ts` already reaches into `frontend/src` — one suite,
// one floor, one number to report.
//
// The types below are declared here rather than imported from `api.ts` on
// purpose: `api.ts` is browser code (it reads `import.meta.env` and calls
// `fetch`), and pulling it into the backend's TypeScript program to test a pure
// function would be a much worse coupling than a structural interface. They are
// the subset of the `/status` payload this logic reads, and the frontend's real
// `DvnCorridor` / `WatchedStatus` are checked against them at every call site.

/** One route's verification set as read on-chain this cycle. */
export interface UlnRead {
  /** Block confirmations the route waits for. Absent means unread — render
   *  nothing, never 0. */
  confirmations?: number;
  requiredCount: number;
  optionalThreshold: number;
  effectiveCount: number;
  requiredDVNs: string[];
  optionalDVNs: string[];
  names: Record<string, string>;
}

/** One active corridor. The message libraries sit OUTSIDE `uln` because they
 *  are read from the endpoint rather than the ULN, so they survive an
 *  unreadable ULN — which is the whole reason `routesOf` keeps such a route. */
export interface RouteRead {
  corridor: string;
  eid: number;
  sendLibrary: string | null;
  sendLibIsDefault: boolean | null;
  receiveLibrary: string | null;
  receiveLibIsDefault: boolean | null;
  uln: UlnRead | null;
}

/** The parts of a watched asset this module reads. */
export interface WatchedRead {
  corridors?: string[];
  dvnSummary: {
    requiredCount: number;
    optionalThreshold: number;
    effectiveCount: number;
    requiredDVNs: string[];
    optionalDVNs: string[];
  } | null;
  dvnNames: Record<string, string> | null;
  dvnCorridors?: RouteRead[] | null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function short(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function dvnName(uln: UlnRead, addr: string): string {
  return uln.names[addr] ?? uln.names[addr.toLowerCase()] ?? short(addr);
}

// ── List keys ─────────────────────────────────────────────────────────────────

/** Stable list keys from the items themselves.
 *
 *  Array index is not an identity: findings and reasons are re-derived every
 *  cycle and a rule that clears shifts every key below it, so React reuses the
 *  wrong node. Content is the identity here. The occurrence suffix only appears
 *  when the same text genuinely repeats among siblings, which keeps the key
 *  unique without reintroducing position as the identifier. */
export function keyed<T>(items: T[], identity: (item: T) => string): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = identity(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n === 0 ? base : `${base}#${n}`, item };
  });
}

// ── What the instance read ────────────────────────────────────────────────────

/** Per-route verification sets, newest read. Falls back to the single-corridor
 *  summary when an instance predates the per-route field.
 *
 *  Corridors whose ULN was NOT readable are kept, deliberately. This used to
 *  filter them out, which discarded everything else the same read did return —
 *  the backend serves send/receive libraries outside `uln` precisely so they
 *  survive an unreadable ULN — and, if every corridor read that way, left the
 *  card sitting on "Reading routes…" forever: a permanent "in progress" for a
 *  permanent read failure. Absence is never rendered as progress here, and it is
 *  never rendered as a value either; the route says plainly what was not read. */
export function routesOf(w: WatchedRead): RouteRead[] {
  const routes = w.dvnCorridors ?? [];
  if (routes.length > 0) return routes;
  if (!w.dvnSummary) return [];
  // dvnSummary carries the DVN set only — it has no libraries and no
  // confirmations reading. Those stay null/absent rather than being filled in:
  // a synthesized value here would be indistinguishable from a real read.
  return [
    {
      corridor: w.corridors?.[0] ?? "route",
      eid: 0,
      sendLibrary: null,
      sendLibIsDefault: null,
      receiveLibrary: null,
      receiveLibIsDefault: null,
      uln: { ...w.dvnSummary, names: w.dvnNames ?? {} },
    },
  ];
}

/** What the live read says about this asset's verification, measured across its
 *  routes. Every sentence and every tile line on this page is built from this —
 *  nothing about a DVN quorum is written down as a constant anywhere, because a
 *  sentence asserting a quorum sitting above rows that read it is the one place
 *  a monitoring page can contradict itself the moment the thing it monitors
 *  changes. */
export interface Verification {
  /** Routes the instance is tracking for this asset. */
  routes: number;
  /** Of those, how many had a readable verification set this cycle. */
  readable: number;
  /** Smallest / largest effective DVN count across the readable routes. */
  min: number | null;
  max: number | null;
  /** The verification set's names — only when every readable route reads the
   *  SAME set and that set is entirely required (no optional threshold to
   *  qualify). Null otherwise, and the copy then declines to summarise. */
  names: string[] | null;
}

export function verificationOf(routes: RouteRead[]): Verification {
  const ulns = routes.map((r) => r.uln).filter((u): u is UlnRead => u != null);
  const counts = ulns.map((u) => u.effectiveCount);
  const sets = ulns.map((u) => u.requiredDVNs.map((a) => dvnName(u, a)));
  const allRequiredOnly = ulns.every(
    (u, i) => u.optionalDVNs.length === 0 && u.optionalThreshold === 0 && sets[i].length === u.effectiveCount
  );
  const uniform = sets.length > 0 && sets.every((s) => s.join("|") === sets[0].join("|"));
  return {
    routes: routes.length,
    readable: ulns.length,
    min: counts.length > 0 ? Math.min(...counts) : null,
    max: counts.length > 0 ? Math.max(...counts) : null,
    names: uniform && allRequiredOnly ? sets[0] : null,
  };
}

/** The tile's one line of substance — route count plus what verifies them. */
export function fleetLine(v: Verification): string {
  const routes = `${v.routes} route${v.routes === 1 ? "" : "s"}`;
  if (v.readable === 0) return `${routes} · verification set not readable this cycle`;
  const quorum =
    v.min === v.max
      ? `${v.min} verifying DVN${v.min === 1 ? "" : "s"}`
      : `${v.min}–${v.max} verifying DVNs`;
  const unread = v.readable < v.routes ? ` · ${v.routes - v.readable} unread` : "";
  return `${routes} · ${quorum}${unread}`;
}

/** The sentence at the top of a third-party asset's panel. Derived from the same
 *  read the corridor rows below it show, so the two cannot disagree — and
 *  deliberately structural: it counts verifiers, it never names one and it never
 *  grades what it counts.
 *
 *  This replaced a sentence that DID name the verification set whenever every
 *  route read the same one. `Verification.names` still carries those names for
 *  the demo asset's rows; nothing on the third-party path may read that field. */
export function structuralNote(v: Verification): string {
  const tail = "Sentinel re-reads and re-verifies this configuration every cycle.";
  const corridors = `${v.routes} corridor${v.routes === 1 ? "" : "s"}`;
  if (v.readable === 0) {
    return (
      `The verification set could not be read on any of this rail's ${corridors} this cycle. ` +
      `Nothing stands in for it. An unread value is never shown as a value. ${tail}`
    );
  }
  const quorum =
    v.min === v.max
      ? `${v.min} verifying DVN${v.min === 1 ? "" : "s"}`
      : `between ${v.min} and ${v.max} verifying DVNs`;
  const unread =
    v.readable < v.routes
      ? ` ${v.routes - v.readable} of them could not be read this cycle.`
      : "";
  const verb = v.routes === 1 ? "reads" : "read";
  return `This rail's ${corridors} currently ${verb} ${quorum}.${unread} ${tail}`;
}

// ── When a recorded verdict stops being evidence ──────────────────────────────

/** A recorded verdict is only written on drift or on a persistent CRITICAL, so a
 *  snapshot that IMPROVES produces no new verdict and the old one stays on file.
 *  Rendering that old verdict's findings under a chip taken from the fresh
 *  snapshot is how a healthy band ends up sitting over stale CRITICAL findings.
 *  A verdict that predates the snapshot is therefore not evidence about the
 *  snapshot, and the page falls through to the live read instead. */
export function verdictIsStale(
  latest: { capturedAt: number } | null | undefined,
  lastSnapshotAt: number | null | undefined
): boolean {
  if (!latest) return true;
  return latest.capturedAt < (lastSnapshotAt ?? 0);
}

// ── The fleet grid's geometry ─────────────────────────────────────────────────

/** Column counts, and the widths they take effect at. The grid's
 *  `grid-template-columns` is set from this same number rather than from a CSS
 *  media query, so the layout and the code that decides where the open detail
 *  goes cannot disagree about how many columns there are. */
export const WIDE_PX = 980;
export const MID_PX = 640;

export function columnsFor(width: number): number {
  if (width >= WIDE_PX) return 3;
  if (width >= MID_PX) return 2;
  return 1;
}

/** Which tile the open detail is rendered after: the LAST tile of the row the
 *  open tile sits in, so the panel spans every column and the whole fleet stays
 *  on screen. Returns -1 when nothing is open.
 *
 *  Clamped to the final tile because the last row is usually short — without the
 *  clamp an open tile in a ragged last row names a position that does not
 *  exist, and the panel never renders at all. */
export function detailAfterIndex(openIndex: number, cols: number, count: number): number {
  if (openIndex < 0 || cols <= 0 || count <= 0) return -1;
  return Math.min(Math.floor(openIndex / cols) * cols + cols - 1, count - 1);
}

// ── Which asset is OURS ───────────────────────────────────────────────────────
//
// The page shows full finding detail for one asset only: the OFT we deployed
// ourselves. Everything else on the watchlist is somebody else's live token, and
// this page states its score and its band without narrating what is wrong with
// it — see publicRead() below for the filter and WITHHELD_LINE for what the page
// says about the omission.
//
// The identity comes from the instance's own pinned-demo-asset config
// (`ATTEST_PINNED` in backend/.env.flare.example): the asset this instance is
// permitted to SIGN about is, by construction, the asset we own. It is expressed
// here in that config's exact `chainKey:address:ticker` form and a test asserts
// the two strings match, so re-pinning the demo asset in the backend and
// forgetting the frontend turns the suite red instead of quietly publishing a
// third party's findings.
//
// It is NOT a ticker comparison. A ticker is a label anyone can choose — this
// page already shipped once with `DEMO_TICKER = "DEMOFT"` matching nothing, and
// the mirror-image failure (a live third-party token whose symbol happens to
// collide with ours, promoted to full disclosure) is the one that matters now.
// Chain + address is the identity.

export interface DemoPin {
  chainKey: string;
  address: string;
  ticker: string;
}

/** Verbatim `ATTEST_PINNED` from the instance's env — the assets this Sentinel
 *  may sign about, which is exactly the asset it owns. */
export const DEMO_PINNED = "flare:0x560C03079FE54Fa53e15b48C615b1ef76D6DF621:MOFT";

export function parseDemoPins(raw: string): DemoPin[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().split(":"))
    .filter((parts) => parts.length === 3 && parts.every((p) => p.trim().length > 0))
    .map(([chainKey, address, ticker]) => ({
      chainKey: chainKey.trim().toLowerCase(),
      address: address.trim().toLowerCase(),
      ticker: ticker.trim(),
    }));
}

/** The chain rows `/status` serves, narrowed to what the pin match needs. */
export interface ChainRef {
  chainId: number;
  chainKey?: string | null;
}

/** True only when this asset IS a pinned demo asset: same address, on the chain
 *  the pin names, resolved through the chain list `/status` serves.
 *
 *  FAILS CLOSED. An unparseable pin, a chain key `/status` does not name, or a
 *  chain list that has not loaded all answer false — and false means the asset
 *  is treated as somebody else's and its findings are withheld. The two failure
 *  directions are not symmetric: withholding our own detail costs depth on one
 *  tile, publishing a third party's findings cannot be taken back. */
export function isDemoAsset(
  asset: { address: string; chainId: number },
  chains: ChainRef[],
  pins: DemoPin[] = parseDemoPins(DEMO_PINNED)
): boolean {
  const addr = asset.address.toLowerCase();
  return pins.some((pin) => {
    if (pin.address !== addr) return false;
    const chain = chains.find((c) => (c.chainKey ?? "").toLowerCase() === pin.chainKey);
    return chain != null && chain.chainId === asset.chainId;
  });
}

// ── What a third-party asset is allowed to say ────────────────────────────────

export type LibState = "pinned" | "default";

/** `null` when the library was not read — the row is then not rendered at all.
 *  Absence is never displayed as a state. */
export function libState(isDefault: boolean | null | undefined): LibState | null {
  if (isDefault == null) return null;
  return isDefault ? "default" : "pinned";
}

/** One corridor reduced to structure: what it is, how many verifiers it takes,
 *  and whether each library is the endpoint default or a pinned one. No DVN
 *  names, no DVN addresses, no library addresses, no grading. */
export interface StructuralRoute {
  corridor: string;
  dvnCount: number | null;
  sendLib: LibState | null;
  receiveLib: LibState | null;
}

export function structuralRoutes(routes: RouteRead[]): StructuralRoute[] {
  return routes.map((r) => ({
    corridor: r.corridor,
    dvnCount: r.uln ? r.uln.effectiveCount : null,
    sendLib: libState(r.sendLibIsDefault),
    receiveLib: libState(r.receiveLibIsDefault),
  }));
}

export function findingsLine(n: number): string {
  if (n === 0) return "no findings";
  return `${n} finding${n === 1 ? "" : "s"}`;
}

export function countsLine(findings: number, corridors: number): string {
  return `${findingsLine(findings)} · ${corridors} corridor${corridors === 1 ? "" : "s"}`;
}

/** Everything a third-party asset's panel is allowed to state, and nothing else.
 *
 *  The filter is HERE, at the render layer, and it is a NARROWING — it builds a
 *  new value out of the parts that may be shown rather than deleting parts of
 *  the fetched one. The `/status` response stays whole, so the copilot and the
 *  report routes are unaffected, and the panel component can only be given a
 *  `PublicRead`: there is no field on it that could leak a reason or a name even
 *  if a later edit tried. */
export interface PublicRead {
  findings: number;
  corridors: number;
  structural: StructuralRoute[];
}

/** The three identity facts every panel carries, ours or anyone else's: which
 *  contract, on which chain, read when.
 *
 *  This is a NARROWING TYPE, not a convenience alias. The third-party panel used
 *  to be handed the whole `WatchedStatus` so that its footer could show these
 *  three fields — which put `assessment.reasons`, `assessment.tis` and
 *  `dvnCorridors[].uln.names` in scope, type-legal, one keystroke away, inside
 *  the one component whose entire job is not to show them. The component's own
 *  comment claimed the prop type prevented that. It did not. It does now. */
export interface AssetIdentity {
  address: string;
  chainId: number;
  lastSnapshotAt: number | null;
}

export function publicRead(reasons: string[], routes: RouteRead[]): PublicRead {
  return {
    findings: reasons.length,
    corridors: routes.length,
    structural: structuralRoutes(routes),
  };
}

/** The page's one-line statement of what it is not showing. Silence would read
 *  as the engine having found nothing. */
export const WITHHELD_LINE =
  "Full findings are shown only for the demo OFT we deployed ourselves. " +
  "Every other asset here shows its score, its band and how many findings it has.";

/** The same fact restated inside a third-party panel, with that asset's counts,
 *  so the panel is never just quietly short of a Findings list. */
export function withheldNote(findings: number, corridors: number): string {
  return (
    `${countsLine(findings, corridors)} in the latest read. The findings themselves are ` +
    `withheld here. This page states them in full for the OFT we deployed ourselves, and no other.`
  );
}

// ── Clocks ────────────────────────────────────────────────────────────────────
//
// `now` is a parameter rather than a `Date.now()` call so these are total
// functions of their arguments like everything else in this file.

export function utc(ts: number | null | undefined): string {
  if (!ts) return "—";
  return `${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "not read yet";
  // Clamped at zero: the timestamps here come from the server and the reader's
  // clock can be behind it, which used to render as "-4s ago".
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── The DVN metadata this fleet was scored against ────────────────────────────

/** When the DVN metadata table was fetched, and whether the instance is serving
 *  a cached one. Derived from `/status`'s own `dvnMeta`, never written down. */
export function metaLine(
  fetchedAt: number | null | undefined,
  stale: boolean,
  now: number
): string {
  if (!fetchedAt) return "DVN metadata: this instance did not report a fetch time";
  const base = `DVN metadata fetched ${utc(fetchedAt)} · ${ago(fetchedAt, now)}`;
  return stale ? `${base} · STALE · scored against a cached table` : base;
}

/** Why that timestamp is on the page at all. The determinism claim is true as
 *  stated and is not weakened here; this names what "a given input" excludes. */
export const META_CAVEAT =
  "The rules are deterministic for a given input. One of those inputs is LayerZero's DVN " +
  "metadata, and its chain coverage changes over time, so a score here can move with no " +
  "on-chain change to the asset.";
