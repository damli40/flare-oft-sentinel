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

// ── What each contract holds, and where the number came from ──────────────────
//
// A holding and a price are PUBLIC CHAIN FACTS: anyone can read a balance and
// anyone can read the enshrined oracle. They are not findings, so this section
// is outside the withholding decision isDemoAsset() makes and every asset gets
// a line. Nothing here touches that function or what it gates.
//
// This is NOT a risk model and the copy never calls it one. It is a measured
// holding, priced by FTSOv2, and the words on the page say exactly that.
//
// Three things this must never do, and each has a function below enforcing it:
//
//   * price an asset that has no feed. Three of the six watched assets have
//     none, so the unpriceable path is the COMMON one, not the edge case. It
//     says "no FTSO feed" — never $0, never blank, never a dash, all three of
//     which read as either "worthless" or "broken";
//   * show a number without the noun that makes it mean something. A contract
//     that CUSTODIES $13.5M and a token that has $155M CIRCULATING are different
//     claims, so basisLabel() puts the noun on the row rather than in a
//     footnote;
//   * let a reader think the price moved the score. It cannot: the rule engine
//     reads the config snapshot and neither a price nor a balance is one of its
//     inputs. That is stated on the page, in EXPOSURE_NOTE, rather than left to
//     be inferred.

/** Which question this row's number answers. */
export type HoldingBasis = "custodied" | "circulating";

/** The holding fields `/status` serves per asset. Structural, like every other
 *  type in this file — `api.ts`'s `AssetExposure` is checked against it at the
 *  call site. Every field is separately nullable because every one is a read
 *  that can fail on its own. */
export interface ExposureRead {
  feed: string | null;
  /** Raw amount held, on the basis `basis` names. */
  amount: string | null;
  decimals: number | null;
  basis: HoldingBasis | null;
  priceUsd: number | null;
  valueUsd: number | null;
  feedTimestamp: number | null;
  stale: boolean;
  readAt: number;
  /** Which contract the amount was read from. A watched OFT and the ERC20 it
   *  moves are not always the same contract, so a page stating a figure has to
   *  be able to say where it came from. */
  pricedToken: string | null;
  /** A lockbox holding nothing because it mints on arrival. */
  mintsOnArrival: boolean;
}

/** Trailing zeros a fixed-precision format left behind. "0.999480" is the same
 *  number as "0.99948" and one of them looks like a rounding artefact. */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** A USD total. Two decimals under a thousand, none above it — cents on a
 *  nine-figure number are noise, and a hundred-million-dollar figure written to
 *  the cent claims a precision the read does not have. */
export function usd(n: number): string {
  const digits = Math.abs(n) < 1000 ? 2 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A USD price per token. Kept at six significant figures rather than two
 *  decimals: several feeds sit far below a cent, and usd() would render every
 *  one of them as "$0.00" — a real price shown as no price. */
export function priceLine(n: number): string {
  if (Math.abs(n) >= 1) {
    return `$${trimZeros(n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }))}`;
  }
  return `$${trimZeros(n.toPrecision(6))}`;
}

/** Raw amount scaled by the token's own decimals.
 *
 *  The division happens in bigint, before anything becomes a float: an
 *  18-decimal token with a billions-scale supply carries a ~10^27 raw value,
 *  and Number() past 2^53 silently rounds. Returns null when either input was
 *  not read — an unknown scale is never guessed at 18. */
export function tokenAmount(
  amount: string | null | undefined,
  decimals: number | null | undefined
): number | null {
  // `== null` on both: an older instance's payload carries neither key, and a
  // missing input must read as "not known", never as 0.
  if (amount == null || decimals == null || decimals < 0) return null;
  let raw: bigint;
  try {
    raw = BigInt(amount);
  } catch {
    return null;
  }
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}

/** A token count, whole units. */
export function amountLine(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 0 });
}

/** The noun that makes the figure mean something. Without it "$13,503,764" is
 *  an unattributed number, and the two bases are not interchangeable: one is
 *  what this contract holds, the other is what exists on the chain.
 *
 *  The chain name is PASSED IN, from /status, never written down here. */
export function basisLabel(basis: HoldingBasis | null, chain: string | null): string | null {
  if (basis === "custodied") return "custodied here";
  if (basis === "circulating") return chain ? `circulating on ${chain}` : "circulating on this chain";
  return null;
}

/** The one line a tile and a panel both carry. Every branch that is not a real
 *  priced figure says which read is missing, and none of them says zero.
 *
 *  The amount branches say "not reported" rather than "not read this cycle", and
 *  the difference is not cosmetic. The whole exposure object is absent when the
 *  READ failed — that is the "this cycle" case, and it is transient. An exposure
 *  that arrived with a null amount means the chain answered and the contract
 *  declined, which for some contracts is true on every cycle, forever; "not read
 *  this cycle" would promise a number that is never coming. */
export function exposureLine(e: ExposureRead | null | undefined, chain: string | null): string {
  if (!e) return "holding not read this cycle";
  if (e.feed === null) return "no FTSO feed · holding not priced";
  if (e.stale) return "FTSO feed stale · holding not priced";
  if (e.priceUsd === null) return "FTSO price not read this cycle";
  // `== null`, not `=== null`. api.ts promises this page tolerates an older
  // instance, and an older instance served this object under a DIFFERENT KEY
  // (`supply`, before fix round 1 renamed it). A strict check lets that shape
  // fall through every guard below and render a bare dollar figure with no
  // basis noun — the exact fabricated number this rewrite removed, printed by
  // the code that removed it. Undefined is not read; it is not a number either.
  if (e.amount == null) return "amount not reported · holding not priced";
  if (e.decimals === null) return "token decimals not reported · holding not priced";
  if (e.valueUsd === null) return "holding not priced";
  const label = basisLabel(e.basis, chain);
  const value = label ? `${usd(e.valueUsd)} ${label}` : usd(e.valueUsd);
  // A measured zero is a real answer, and on this shape it has a real reason.
  // Saying it on the ROW keeps a reader in the grid from reading it as a bug.
  return e.mintsOnArrival ? `${value} · mints on arrival` : value;
}

/** Why a lockbox that holds nothing is the row to WORRY about, not the row to
 *  skip. Null for every other row, so it never appears as boilerplate.
 *
 *  ⚠️ This note was rewritten on 2026-08-08 because the first version had the
 *  risk backwards. It read as "nothing here, nothing to price", which invites a
 *  reader to treat $0 as $0 of exposure. The opposite is true. A lockbox caps
 *  the loss at what it locks; a mint-on-arrival OFT has no such cap, because a
 *  forged inbound message MINTS rather than releases. The empty contract is the
 *  more dangerous shape, and the page has to say so.
 *
 *  Still deliberately does NOT quote the token's total supply as the figure.
 *  Supply is not this contract's holding, and the honest scale for this shape is
 *  what actually crosses the path, not what exists somewhere. */
export const MINTS_ON_ARRIVAL_NOTE =
  "This contract holds nothing to price, and that is not reassurance. It mints the token " +
  "when a message arrives instead of releasing it from a vault, so a forged message creates " +
  "supply that nothing backs. A custody balance would cap what a broken verification stack " +
  "could take. There is none here to cap it.";

export function mintNote(e: ExposureRead | null | undefined): string | null {
  return e?.mintsOnArrival ? MINTS_ON_ARRIVAL_NOTE : null;
}

/** Where the number came from and when, for the panel. A figure on a scoring
 *  page with no provenance is a figure a reader has to take on trust, and this
 *  one is checkable: the feed is named, the oracle is named, and the read time
 *  is the instance's own. */
export function exposureSource(e: ExposureRead | null | undefined): string {
  if (!e) return "This instance did not read a price this cycle.";
  if (e.feed === null) return "This ticker has no FTSOv2 feed, so this page states no price for it.";
  return `${e.feed} from FTSOv2, read ${utc(e.readAt)}.`;
}

/** The arithmetic behind the figure, so a reader can redo it — and the noun
 *  again, because the multiplication is only checkable if you know what was
 *  multiplied. Null when either input is missing: a half-shown multiplication is
 *  worse than none. */
export function exposureBasis(e: ExposureRead | null | undefined): string | null {
  if (!e || e.priceUsd === null) return null;
  const amount = tokenAmount(e.amount, e.decimals);
  if (amount === null) return null;
  const noun = e.basis === "circulating" ? "total supply" : "balance held";
  return `${noun} ${amountLine(amount)} × ${priceLine(e.priceUsd)}`;
}

/** Which contract the amount came from, when that is not the contract the row
 *  links to. A figure sitting above a link to a different address is a number
 *  attributed to the wrong place. Null when they match, when there is no amount,
 *  or when the instance does not serve the field. */
export function exposureTokenNote(
  e: ExposureRead | null | undefined,
  assetAddress: string
): string | null {
  // `== null` for the same reason as exposureLine: a payload from an older
  // instance carries no `amount` key at all, and attributing an amount that was
  // never served to a contract is worse than saying nothing.
  if (!e || e.amount == null || !e.pricedToken) return null;
  if (e.pricedToken.toLowerCase() === assetAddress.toLowerCase()) return null;
  return `Read from ${short(e.pricedToken)}, the token this OFT moves.`;
}

/** The sort key. Null for anything unpriced, which sorts last. */
export function exposureValue(e: ExposureRead | null | undefined): number | null {
  return e?.valueUsd ?? null;
}

/** The fleet ordered by the size of the priced holding, biggest first, with
 *  everything unpriceable or unread last in the order it arrived.
 *
 *  Stable on purpose: three of the six watched assets have no feed, so the tail
 *  is a third of the grid, and a comparator that reshuffled ties would move
 *  tiles around on every poll for no reason a reader could see. */
export function sortByExposure<T extends { exposure?: ExposureRead | null }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const av = exposureValue(a.item.exposure);
      const bv = exposureValue(b.item.exposure);
      if (av === null && bv === null) return a.i - b.i;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv === av ? a.i - b.i : bv - av;
    })
    .map((x) => x.item);
}

/** Said at page level, next to the withholding line, because a dollar figure
 *  sitting on a scoring page is read as an input to the score unless the page
 *  says otherwise — and the determinism claim this whole build rests on is
 *  exactly that the score is a function of the config and the rules.
 *
 *  It also names both bases, because the grid shows both and a reader comparing
 *  two rows is entitled to know they answer different questions. */
export const EXPOSURE_NOTE =
  "Each row shows a measured holding priced by FTSOv2: what the contract itself custodies, " +
  "or what its token has circulating on this chain. It does not affect the score. " +
  "The score comes from the configuration rules alone.";


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
