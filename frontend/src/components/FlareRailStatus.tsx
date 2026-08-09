import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getSentinelStatus, getSentinelVerdicts } from "../api.ts";
import { setChainConfig, txUrl, oftUrl, contractUrl, chainNameFor } from "../explorer.ts";
import type { SentinelStatus, SentinelVerdict, WatchedStatus } from "../api.ts";
// Everything this page computes rather than renders lives in rail-logic.ts, and
// is tested from the backend suite. Keeping it out of the component is what lets
// the two behaviour fixes below (a stale verdict, an unreadable ULN) and the
// grid's insertion arithmetic have tests at all.
import {
  EXPOSURE_NOTE,
  META_CAVEAT,
  WITHHELD_LINE,
  ago,
  columnsFor,
  detailAfterIndex,
  dvnName,
  exposureBasis,
  exposureLine,
  exposureSource,
  exposureTokenNote,
  findingsLine,
  fleetLine,
  isDemoAsset,
  keyed,
  metaLine,
  mintNote,
  publicRead,
  routesOf,
  short,
  sortByExposure,
  structuralNote,
  utc,
  verdictIsStale,
  verificationOf,
  withheldNote,
} from "../rail-logic.ts";
import type { AssetIdentity, ExposureRead, PublicRead, RouteRead, StructuralRoute } from "../rail-logic.ts";

// ── Page constants ────────────────────────────────────────────────────────────
// One judge-facing page: what the Sentinel instance currently reads off the
// OFT rails it watches, refreshed on a fixed cadence. It states what is verified
// and what the rules found. It never narrates who was right about anything.
//
// LAYOUT: a fleet grid. Every watched asset is one compact tile, all of them
// visible at once, and a tile expands to that asset's full reading. The reader
// this is built for has about a minute and six assets to form a view of, so the
// default state has to be the whole fleet rather than the top of a scroll.

const POLL_MS = 60_000;

// Explorer links come from /status (backend resolves them from the chain
// registry and SENTINEL_CHAIN_ID), not from a literal here. Two reasons this
// page stopped hardcoding its own: a second copy of the same constant is how the
// rest of the build ended up linking the wrong network's transactions, and the
// value itself pointed at an explorer where this build's AuditRegistry source
// does NOT display — Task 6 verified both contracts on the explorer the registry
// now names, and recommended linking there. That is now the registry's value.

/** The public repository for this instance (created in the export step). */
const REPO_URL = "https://github.com/damli40/flare-oft-sentinel";

// The OFT we deployed ourselves for the detection demo is identified by
// isDemoAsset() in rail-logic.ts — chain + address, held byte-identical to the
// backend's ATTEST_PINNED by a test. See the hazard note above DEMO_PINNED: that
// tie has to be cut now that this instance signs for every asset it watches.
// It used to be a ticker comparison against a literal here, which
// had already failed once in the other direction ("DEMOFT" matched nothing, so
// the demo card never rendered). See the note above isDemoAsset for why a ticker
// cannot be the identity now that the answer decides what a third party's tile
// is allowed to say.

const SUBHEAD =
  "deterministic LayerZero config monitoring · rules recomputable, no LLM in the verdict path";

const FOOTER_LINE =
  "Config changes are rare, which is why a machine has to check them every hour and publish a result you can recompute.";

// Chain name interpolated from /status like everything else on this page. The
// file already promised "never hardcoded" a few lines below while two constants
// did exactly that.
const demoNote = (chain: string | null) =>
  `An OFT we deployed${chain ? ` on ${chain}` : ""} ourselves and left on the endpoint's default configuration. ` +
  "It carries no value and nothing depends on it. It exists so we can show the detection path end to end " +
  "on an asset that is ours to break.";

// ── Formatting helpers (same idioms as the production dashboard) ──────────────

type Band = "PASS" | "AT_RISK" | "CRITICAL";

function bandClass(band: Band | null): string {
  if (band === "CRITICAL") return "spill s-crit";
  if (band === "AT_RISK") return "spill s-warn";
  if (band === "PASS") return "spill s-safe";
  return "spill s-scan";
}

function BandChip({ band }: { band: Band | null }) {
  return (
    <span className={bandClass(band)}>
      {/* The coloured dot repeats the word beside it. Announcing it would read
          as a stray bullet, so it is hidden from assistive technology. */}
      <span className="d" aria-hidden="true" />
      {band ?? "PENDING"}
    </span>
  );
}

/** Newest verdict for one OFT, optionally only the ones that were attested. */
function latestVerdictFor(
  verdicts: SentinelVerdict[],
  address: string,
  attestedOnly = false
): SentinelVerdict | null {
  const mine = verdicts.filter(
    (v) => v.oft.toLowerCase() === address.toLowerCase() && (!attestedOnly || !!v.attestTxHash)
  );
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (b.capturedAt >= a.capturedAt ? b : a));
}

// ── Detail building blocks ────────────────────────────────────────────────────

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="to-sec-lbl">{children}</div>;
}

function DvnRow({ addr, name, kind }: { addr: string; name: string; kind: "required" | "optional" | "sole" }) {
  const cls = kind === "sole" ? "to-dvn-st bad" : kind === "optional" ? "to-dvn-st opt" : "to-dvn-st ok";
  const label = kind === "sole" ? "sole verifier" : kind === "optional" ? "optional" : "✓ required";
  return (
    <div className="to-dvn-row">
      <div>
        <div className="to-dvn-nm">{name}</div>
        <div className="to-dvn-ad">{short(addr)}</div>
      </div>
      <span className={cls}>{label}</span>
    </div>
  );
}

/** One "label / value / state" line in the route-facts block. Renders nothing
 *  when the address was not read — no row, no dash, no "unknown". The state
 *  word is dropped the same way when the default flag was not read. */
function LibRow({ label, addr, isDefault }: { label: string; addr: string | null; isDefault: boolean | null }) {
  if (addr == null) return null;
  return (
    <div className="to-dvn-row">
      <div>
        <div className="to-dvn-nm">{label}</div>
        <div className="to-dvn-ad">{short(addr)}</div>
      </div>
      {isDefault != null && (
        <span className="to-dvn-st" style={{ color: "var(--faint)" }}>
          {isDefault ? "default" : "pinned"}
        </span>
      )}
    </div>
  );
}

/** The rest of a route's trust story under the DVN quorum: which message
 *  libraries it uses and how many block confirmations it waits for.
 *
 *  This block STATES configuration, it does not grade it. "default" and
 *  "pinned" carry identical styling on purpose — whether a default library is
 *  a problem for this asset is the findings list's verdict, and rendering that
 *  judgement in two places lets the two disagree. Anything unread renders
 *  nothing at all; absence is never shown as a value, and never as safety.
 *
 *  This is also what survives an unreadable ULN, which is why it is read from
 *  the route rather than from `route.uln`. */
function RouteFacts({ route }: { route: RouteRead }) {
  const confirmations = route.uln?.confirmations;
  const hasLibrary = route.sendLibrary != null || route.receiveLibrary != null;
  if (!hasLibrary && typeof confirmations !== "number") return null;
  return (
    <>
      <div className="to-sec-lbl" style={{ marginTop: 14 }}>
        Libraries &amp; confirmations
      </div>
      <LibRow label="Send library" addr={route.sendLibrary} isDefault={route.sendLibIsDefault} />
      <LibRow label="Receive library" addr={route.receiveLibrary} isDefault={route.receiveLibIsDefault} />
      {typeof confirmations === "number" && (
        <div className="to-dvn-row">
          <div className="to-dvn-nm">Block confirmations</div>
          <span className="to-dvn-st" style={{ color: "var(--faint)" }}>
            {confirmations}
          </span>
        </div>
      )}
    </>
  );
}

function RouteBlock({ route }: { route: RouteRead }) {
  const uln = route.uln;
  const sole = uln != null && uln.effectiveCount <= 1;
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="to-dvn-thresh" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="to-corr">{route.corridor}</span>
        {uln ? (
          <span>
            <b>
              {uln.effectiveCount} verifying DVN{uln.effectiveCount === 1 ? "" : "s"}
            </b>
            <span style={{ color: "var(--faint)", marginLeft: 6, fontSize: 11 }}>
              {uln.requiredCount} required
              {uln.optionalThreshold > 0
                ? ` + ${uln.optionalThreshold}-of-${uln.optionalDVNs.length} optional`
                : ""}
              {route.eid ? ` · eid ${route.eid}` : ""}
            </span>
          </span>
        ) : (
          route.eid !== 0 && (
            <span style={{ color: "var(--faint)", fontSize: 11 }}>eid {route.eid}</span>
          )
        )}
      </div>
      {uln ? (
        <>
          {keyed(uln.requiredDVNs, (a) => `r-${a}`).map(({ key, item }) => (
            <DvnRow key={key} addr={item} name={dvnName(uln, item)} kind={sole ? "sole" : "required"} />
          ))}
          {keyed(uln.optionalDVNs, (a) => `o-${a}`).map(({ key, item }) => (
            <DvnRow key={key} addr={item} name={dvnName(uln, item)} kind="optional" />
          ))}
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.5 }}>
          The verification set for this route could not be read this cycle, so no DVN rows are shown
          here. Nothing stands in for it. An unread value is never rendered as an empty one.
        </div>
      )}
      <RouteFacts route={route} />
    </div>
  );
}

/** What this rail is worth at the price the enshrined oracle last published, the
 *  arithmetic behind it, and where the number came from.
 *
 *  Rendered for EVERY asset, ours or anyone else's. A token's total supply and a
 *  public price feed are chain facts any reader can call for themselves, so they
 *  are not part of what this page withholds — the withholding is about findings,
 *  and isDemoAsset() still decides that on its own, unchanged.
 *
 *  This block states a value and never grades one. It also cannot move a verdict:
 *  the score comes from the rule engine reading the config snapshot, and a price
 *  is not one of its inputs. EXPOSURE_NOTE says that at page level, where a
 *  reader who never opens a panel still sees it. */
function ExposureBlock({
  exposure,
  assetAddress,
  chain,
}: {
  exposure: ExposureRead | null;
  assetAddress: string;
  chain: string | null;
}) {
  const basis = exposureBasis(exposure);
  const tokenNote = exposureTokenNote(exposure, assetAddress);
  const mint = mintNote(exposure);
  return (
    <div>
      <SectionLabel>Holding</SectionLabel>
      <div style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.55 }}>
        {exposureLine(exposure, chain)}
      </div>
      {/* Why a real zero is a real zero. Only on the one shape that produces it,
          so it never reads as boilerplate — and it does NOT quote the token's
          total supply, which is a different number about a different question. */}
      {mint && (
        <div style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.5, marginTop: 8 }}>{mint}</div>
      )}
      {/* The multiplication, when both of its inputs were read. Absent rather
          than half-shown: "balance held … × " with nothing after it would be a
          worse artefact than no line. */}
      {basis && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", marginTop: 8 }}>
          {basis}
        </div>
      )}
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", marginTop: 6 }}>
        {exposureSource(exposure)}
      </div>
      {/* Only when the amount came off a different contract than the one this
          panel links to. A figure attributed to the wrong address is worse than
          no figure. */}
      {tokenNote && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", marginTop: 6 }}>
          {tokenNote}
        </div>
      )}
    </div>
  );
}

function Findings({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--faint)" }}>
        No findings in the latest read. Every rule the engine applies to this rail passed.
      </div>
    );
  }
  return (
    <ul className="to-rl">
      {keyed(reasons, (r) => r).map(({ key, item }) => (
        <li key={key}>{item}</li>
      ))}
    </ul>
  );
}

function RouteList({ routes }: { routes: RouteRead[] }) {
  return (
    <div>
      <SectionLabel>DVN set per route</SectionLabel>
      {routes.length > 0 ? (
        keyed(routes, (r) => `${r.eid}-${r.corridor}`).map(({ key, item }) => (
          <RouteBlock key={key} route={item} />
        ))
      ) : (
        <div style={{ fontSize: 12.5, color: "var(--faint)" }}>Reading routes…</div>
      )}
    </div>
  );
}

/** Address, chain and read time — the three identity facts every panel carries,
 *  ours or anyone else's. The chain name comes from /status like every other
 *  chain label on this page.
 *
 *  Takes an `AssetIdentity`, not a `WatchedStatus`. This sits on the public
 *  render path, so what it is HANDED is part of the withholding guarantee: a
 *  component that holds the whole record can reach past the filter without any
 *  type change at all. The demo panel passes its full `WatchedStatus` here and
 *  that still type-checks — the narrow type is a subset of it — so the demo
 *  path loses nothing. */
function ReadFooter({ asset }: { asset: AssetIdentity }) {
  const chain = chainNameFor(asset.chainId);
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <a
        className="txlink"
        href={oftUrl(asset.chainId, asset.address) ?? undefined}
        target="_blank"
        rel="noreferrer"
      >
        {short(asset.address)} ↗
      </a>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)" }}>
        {chain ? `${chain} · ` : ""}read {utc(asset.lastSnapshotAt)}
      </span>
    </div>
  );
}

// ── Expanded detail: a rail that is not ours ──────────────────────────────────
//
// Scores and bands, and the structure underneath them — no finding text, no
// remediation text, no DVN names. See publicRead() in rail-logic.ts for the
// filter and WITHHELD_LINE for what the page says about the omission.
//
// The narrowing is enforced by the PROP TYPES, not by discipline: everything
// this component is handed is either a `PublicRead` (three counts and a list of
// structural facts) or an `AssetIdentity` (address, chain, read time). Neither
// has a field capable of carrying a reason, a DVN name or a transaction-intent
// string, so a later edit cannot reintroduce one here without first widening a
// type, which is a visible change with tests behind it.
//
// That sentence was FALSE until fix round 1, and worth reading as a warning
// rather than as history: the component took the whole `WatchedStatus` — for
// the three fields its footer needed — while claiming exactly the property
// above. `w.assessment.reasons`, `w.assessment.tis` and
// `w.dvnCorridors[].uln.names` were in scope and type-legal the entire time.
// A comment asserting a guarantee is not the guarantee.

function StructuralRouteBlock({ r }: { r: StructuralRoute }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        className="to-dvn-thresh"
        style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
      >
        <span className="to-corr">{r.corridor}</span>
        {r.dvnCount !== null ? (
          <b>
            {r.dvnCount} verifying DVN{r.dvnCount === 1 ? "" : "s"}
          </b>
        ) : (
          <span style={{ color: "var(--faint)", fontSize: 11 }}>
            verification set not readable this cycle
          </span>
        )}
      </div>
      {r.sendLib && (
        <div className="to-dvn-row">
          <div className="to-dvn-nm">Send library</div>
          <span className="to-dvn-st" style={{ color: "var(--faint)" }}>
            {r.sendLib}
          </span>
        </div>
      )}
      {r.receiveLib && (
        <div className="to-dvn-row">
          <div className="to-dvn-nm">Receive library</div>
          <span className="to-dvn-st" style={{ color: "var(--faint)" }}>
            {r.receiveLib}
          </span>
        </div>
      )}
    </div>
  );
}

// The signature stays on ONE line. rail-logic.test.ts reads this function's body
// by slicing to the first brace at column 0, so a multi-line prop destructuring
// would end the slice at `}: {` and quietly shrink the leak guard below to the
// four prop names.
function RailBody({ id, read, note, exposure, chain }: { id: AssetIdentity; read: PublicRead; note: string; exposure: ExposureRead | null; chain: string | null }) {
  return (
    <div className="bd" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--text-2)" }}>{note}</p>

      {/* A fourth narrow prop, not a widening. ExposureRead carries a feed name,
          a price, a supply and two timestamps — there is no field on it capable
          of holding a finding, a verifier's name or a remediation string, so the
          guarantee the prop types make on this path is unchanged. */}
      <ExposureBlock exposure={exposure} assetAddress={id.address} chain={chain} />

      <div>
        <SectionLabel>Findings</SectionLabel>
        <div style={{ fontSize: 12.5, color: "var(--faint)", lineHeight: 1.55 }}>
          {withheldNote(read.findings, read.corridors)}
        </div>
      </div>

      <div>
        <SectionLabel>Corridors</SectionLabel>
        {read.structural.length > 0 ? (
          keyed(read.structural, (r) => r.corridor).map(({ key, item }) => (
            <StructuralRouteBlock key={key} r={item} />
          ))
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--faint)" }}>Reading routes…</div>
        )}
      </div>

      <ReadFooter asset={id} />
    </div>
  );
}

// ── Expanded detail: the demo OFT — full finding detail + its attestation ─────

function DemoBody({
  w,
  routes,
  verdicts,
  registry,
}: {
  w: WatchedStatus;
  routes: RouteRead[];
  verdicts: SentinelVerdict[];
  registry?: string;
}) {
  const latest = latestVerdictFor(verdicts, w.address) ?? w.latestVerdict;
  const attested =
    latestVerdictFor(verdicts, w.address, true) ?? (w.latestVerdict?.attestTxHash ? w.latestVerdict : null);

  // A recorded verdict older than the snapshot is not evidence about the
  // snapshot — see verdictIsStale() in rail-logic.ts for why, and
  // rail-logic.test.ts for the case that proves it. Stale ⇒ fall through to the
  // live read below, so a fresh chip can never sit over old CRITICAL findings.
  const findings = verdictIsStale(latest, w.lastSnapshotAt)
    ? []
    : latest?.pdr?.findings?.filter((f) => f.severity !== "PASS") ?? [];

  return (
    <div className="bd" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--text-2)" }}>
        {demoNote(chainNameFor(w.chainId))}
      </p>

      {/* Same block, same source, on our own asset as on anyone else's. This one
          has no feed, so it says so rather than showing a zero. */}
      <ExposureBlock exposure={w.exposure ?? null} assetAddress={w.address} chain={chainNameFor(w.chainId)} />

      <div>
        <SectionLabel>Findings</SectionLabel>
        {findings.length > 0 ? (
          <div>
            {keyed(findings, (f) => `${f.severity}|${f.check}|${f.detail}`).map(({ key, item: f }) => (
              <div
                key={key}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "9px 0",
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <span
                  className="to-dvn-st"
                  style={{
                    flex: "none",
                    color:
                      f.severity === "CRITICAL"
                        ? "var(--critical)"
                        : f.severity === "HIGH"
                        ? "var(--warn)"
                        : "var(--scan)",
                  }}
                >
                  {f.severity}
                </span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{f.check}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.45, marginTop: 2 }}>
                    {f.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Findings reasons={w.assessment?.reasons ?? []} />
        )}
      </div>

      <RouteList routes={routes} />

      <div>
        <SectionLabel>Latest attestation</SectionLabel>
        {attested?.attestTxHash ? (
          <>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a
                className="txlink"
                href={txUrl(attested.attestTxHash) ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                ⛓ attestation{attested.attestationId !== undefined ? ` #${attested.attestationId}` : ""} ↗
              </a>
              {attested.alertTxHash && (
                <a
                  className="txlink"
                  href={txUrl(attested.alertTxHash) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  🔔 alert ↗
                </a>
              )}
              {registry && (
                <a className="txlink" href={contractUrl(registry) ?? undefined} target="_blank" rel="noreferrer">
                  AuditRegistry {short(registry)} ↗
                </a>
              )}
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--faint)",
                marginTop: 10,
                lineHeight: 1.7,
                wordBreak: "break-all",
              }}
            >
              verdict hash {attested.verdictHash}
              <br />
              {attested.pdr ? `rules v${attested.pdr.rulesVersion} · ` : ""}
              keccak256(JSON.stringify(PDR)) == verdictHash · recompute it yourself
              <br />
              captured {utc(attested.capturedAt)}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--faint)" }}>
            No attestation written yet. One is written the next time this
            asset's configuration reads differently from the last stored
            fingerprint, so an unchanged asset stays unsigned on purpose.
          </div>
        )}
      </div>

      <ReadFooter asset={w} />
    </div>
  );
}

// ── The fleet grid ────────────────────────────────────────────────────────────

/** The column count is JS state rather than a CSS media query so that the grid's
 *  `grid-template-columns` and the code deciding where the open detail goes read
 *  the same number — see columnsFor() / detailAfterIndex() in rail-logic.ts. */
function useColumns(): number {
  const [cols, setCols] = useState(() =>
    typeof window === "undefined" ? 3 : columnsFor(window.innerWidth)
  );
  useEffect(() => {
    const onResize = () => setCols(columnsFor(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return cols;
}

function FleetTile({
  w,
  demo,
  routes,
  open,
  onToggle,
  labelId,
  panelId,
}: {
  w: WatchedStatus;
  demo: boolean;
  routes: RouteRead[];
  open: boolean;
  onToggle: () => void;
  labelId: string;
  panelId: string;
}) {
  const band = (w.assessment?.riskLevel ?? null) as Band | null;
  const score = w.assessment?.score ?? null;
  return (
    <h3 className="rt-h">
      <button
        type="button"
        className={`rt-tile${open ? " on" : ""}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
      >
        <span className="rt-top">
          <span className="rt-tk" id={labelId}>
            {w.ticker}
          </span>
          {demo && (
            <span className="rt-demo">
              <span aria-hidden="true">★ </span>demo OFT
            </span>
          )}
        </span>
        <span className="rt-mid">
          <BandChip band={band} />
          {score !== null && <span className="rt-score">{score}/100</span>}
        </span>
        <span className="rt-sub">{fleetLine(verificationOf(routes))}</span>
        {/* How many findings, on every tile including the ones whose findings
            are withheld. The count is the part a reader needs to see that a
            band is not an empty verdict; the text behind it is the part this
            page states only for the asset it owns. */}
        {/* The optional chain runs the whole way. `w.assessment?.reasons.length`
            stops after `assessment`, so a payload carrying an assessment with no
            reasons array would throw here and take the WHOLE page down rather
            than one tile — every other site in this file already guards it. */}
        <span className="rt-sub" style={{ color: "var(--faint)" }}>
          {findingsLine(w.assessment?.reasons?.length ?? 0)}
        </span>
        {/* What is at stake on this rail, which is also the key the grid is
            sorted by. It is not a verdict and it is not an input to one — the
            page says so above the grid, where a reader who opens no tile at all
            still reads it. */}
        <span className="rt-sub" style={{ color: "var(--faint)" }}>
          {exposureLine(w.exposure ?? null, chainNameFor(w.chainId))}
        </span>
        <span className="rt-cue" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
    </h3>
  );
}

function DetailPanel({
  w,
  demo,
  routes,
  verdicts,
  registry,
  labelId,
  panelId,
}: {
  w: WatchedStatus;
  demo: boolean;
  routes: RouteRead[];
  verdicts: SentinelVerdict[];
  registry?: string;
  labelId: string;
  panelId: string;
}) {
  const band = (w.assessment?.riskLevel ?? null) as Band | null;
  const score = w.assessment?.score ?? null;

  // The panel is NOT adjacent to the tile that opened it. It is rendered after
  // the last tile of that tile's row, so at three columns opening the first tile
  // gives a DOM order of tile, tile, tile, panel — a keyboard or screen-reader
  // user would have to pass two unrelated assets to reach the reading they just
  // asked for, and nothing would announce that anything appeared. `aria-controls`
  // does not fix that: VoiceOver ignores it outright and the Windows readers
  // honour it only partially.
  //
  // So move focus into the panel when it opens. It is a `<section>` with an
  // accessible name (aria-labelledby → the tile's ticker), so a reader landing
  // here announces the region it entered. tabIndex={-1} makes it focusable
  // programmatically without adding a stop to the tab order, and preventScroll
  // keeps the grid from jumping under a mouse user who can already see it.
  //
  // Keyed on panelId, not on every render: the page re-polls every 60s, and
  // stealing focus on each poll would be worse than the problem being fixed.
  // Closing needs no counterpart — closing is done from the trigger, so focus is
  // already back on the button by the time the panel is removed.
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [panelId]);

  return (
    <section
      className="card2 rt-panel"
      id={panelId}
      aria-labelledby={labelId}
      ref={panelRef}
      tabIndex={-1}
    >
      <div className="hd">
        <span style={{ fontSize: 15, fontWeight: 600 }}>{w.ticker}</span>
        <BandChip band={band} />
        <span className="tag">
          {score !== null ? `${score}/100 · ` : ""}
          as of {ago(w.lastSnapshotAt, Date.now())}
        </span>
      </div>
      {demo ? (
        <DemoBody w={w} routes={routes} verdicts={verdicts} registry={registry} />
      ) : (
        <RailBody
          // Identity is spelled out field by field rather than passed as `w`.
          // That is the whole narrowing: what crosses this boundary is three
          // scalars, so nothing inside RailBody can reach a reason or a name
          // even by accident.
          id={{ address: w.address, chainId: w.chainId, lastSnapshotAt: w.lastSnapshotAt }}
          read={publicRead(w.assessment?.reasons ?? [], routes)}
          note={structuralNote(verificationOf(routes))}
          exposure={w.exposure ?? null}
          chain={chainNameFor(w.chainId)}
        />
      )}
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function FlareRailStatus() {
  const [status, setStatus] = useState<SentinelStatus | null>(null);
  const [verdicts, setVerdicts] = useState<SentinelVerdict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // ONE tile open at a time. Six assets on one screen is the whole point of the
  // grid, and several open details at once buries it — one asset's routes alone
  // can run to twenty blocks. Opening a second tile closes the first, so
  // comparing two assets is one click rather than close-then-open.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const cols = useColumns();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [s, v] = await Promise.all([getSentinelStatus(), getSentinelVerdicts()]);
        setChainConfig(s);
        if (cancelled) return;
        setStatus(s);
        setVerdicts(v);
        setError(null);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? "The instance did not answer.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const watched = status?.watched ?? [];
  const chainRefs = status?.chains ?? [];
  // Ours or somebody else's, decided by the pinned chain+address identity of the
  // OFT we deployed — never by a ticker string, which any asset can share. It
  // fails closed: before the chain list loads, every asset reads as a third
  // party's and its findings stay withheld. This question is separate from what
  // the instance signs on chain, which now covers every watched asset.
  const isDemo = (w: WatchedStatus) => isDemoAsset(w, chainRefs);
  // The live rails are ordered by what is at stake on them, biggest first, with
  // the unpriceable ones last in the order the instance served them. The demo
  // OFT stays after all of them regardless of where its value would put it: it
  // is a tile like any other, marked as ours, and the live rails read first.
  const assets = [...sortByExposure(watched.filter((w) => !isDemo(w))), ...watched.filter(isDemo)];
  const keyOf = (w: WatchedStatus) => `${w.chainId}-${w.address}`;

  // Chain names come only from /status — never hardcoded, so the scope line
  // follows the backend's watchlist without a frontend edit.
  // Single source for this page's chain label: the backend's own answer.
  const sentinelChainName = status?.chain?.name ?? status?.chains?.[0]?.name ?? null;

  const scope =
    status?.chains && status.chains.length > 0
      ? status.chains.map((c) => `${c.count} OFT${c.count === 1 ? "" : "s"} on ${c.name}`).join(" · ")
      : loaded && !error
      ? "watchlist empty"
      : "connecting";

  const newestRead = watched.reduce<number | null>(
    (acc, w) => (w.lastSnapshotAt && (acc === null || w.lastSnapshotAt > acc) ? w.lastSnapshotAt : acc),
    null
  );

  // Read the clock once per render and pass it in, rather than letting the
  // formatter call Date.now() itself. That is what makes every "N ago" string
  // testable against a fixed instant instead of against whenever the test ran.
  // This component re-renders on each 60s poll, so the value stays current.
  const now = Date.now();

  // Whether the instance is serving a CACHED DVN metadata table. Read once, here,
  // because it drives two things that must not be able to disagree: the wording
  // metaLine() produces and the colour the line is rendered in. Deriving the
  // colour by looking for "STALE" in the returned string would couple the page's
  // styling to that sentence's wording; this couples both to the boolean.
  // Absent `dvnMeta` (an older instance that does not serve the field) is FALSE
  // here and metaLine then says the fetch time was not reported — absence is
  // never rendered as freshness.
  const metaStale = status?.dvnMeta?.stale ?? false;

  // Where the open detail goes: after the LAST tile of the row the open tile
  // sits in, spanning every column. The whole fleet therefore stays on screen
  // and the grid keeps its shape — expanding in place would push the rest of
  // the fleet below the detail and leave the open tile's row half empty.
  const openIndex = assets.findIndex((w) => keyOf(w) === openKey);
  const detailAfter = detailAfterIndex(openIndex, cols, assets.length);

  return (
    <div className="page" style={{ paddingBottom: 20 }}>
      {/* ── Zone 1: header ────────────────────────────────────────────────── */}
      <header style={{ padding: "48px 0 26px" }}>
        <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="live-dot" aria-hidden="true" />
          {scope}
        </div>
        <h1 style={{ fontSize: 38, fontWeight: 700, letterSpacing: "-0.02em", margin: "16px 0 12px" }}>
          {sentinelChainName ? `${sentinelChainName} OFT Rail Status` : "OFT Rail Status"}
        </h1>
        <p style={{ margin: 0, maxWidth: 760, fontSize: 15.5, lineHeight: 1.55, color: "var(--text-2)" }}>
          {SUBHEAD}
        </p>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--faint)",
            marginTop: 14,
            letterSpacing: ".04em",
          }}
        >
          newest read {ago(newestRead, now)} · this page refreshes every 60s
          {status?.msi !== null && status?.msi !== undefined ? ` · fleet index ${status.msi}/100` : ""}
        </div>

        {/* ── The third-party input the whole fleet below was scored against ──
            Every verdict on this page is a function of two things: what we read
            off the chain, and LayerZero's published DVN metadata. The second one
            is somebody else's table, refetched on a cycle, and its chain coverage
            grows. A page that prints the verdicts and never says how old that
            table is has quietly presented a reading as a constant.

            Derived from /status's own `dvnMeta`, never written down here. When
            the instance is serving a cached table the line is marked in the
            page's warning colour as well as in words — driven off `metaStale`,
            not off the text of the line. */}
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: metaStale ? "var(--warn)" : "var(--faint)",
            marginTop: 7,
            letterSpacing: ".04em",
          }}
        >
          {/* Repeats the word "STALE" that metaLine already puts in the line, so
              it is hidden from assistive technology the same way the band chip's
              dot is. */}
          {metaStale && <span aria-hidden="true">⚠ </span>}
          {metaLine(status?.dvnMeta?.fetchedAt, metaStale, now)}
        </div>

        <p
          style={{
            margin: "14px 0 0",
            maxWidth: 760,
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--text-2)",
          }}
        >
          {META_CAVEAT}
        </p>
      </header>

      {/* ── Reachability ──────────────────────────────────────────────────── */}
      {!loaded && (
        <div className="card2">
          <div className="bd" style={{ fontSize: 13.5, color: "var(--text-2)" }}>
            Reading the live instance…
          </div>
        </div>
      )}

      {loaded && error && !status && (
        <div className="card2">
          <div className="hd">
            <h2 className="rt-card-h">Instance unreachable</h2>
            <span className="spill s-scan">
              <span className="d" aria-hidden="true" />
              RETRYING
            </span>
          </div>
          <div className="bd" style={{ fontSize: 13.5, color: "var(--text-2)", lineHeight: 1.6 }}>
            This page could not reach the Sentinel instance, so there is nothing to show yet. It retries
            every 60 seconds. Nothing here is cached, and an unreachable instance is never rendered as a
            healthy one.
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", marginTop: 12 }}>
              {error}
            </div>
          </div>
        </div>
      )}

      {loaded && error && status && (
        <div className="alert-banner" style={{ marginBottom: 20 }}>
          <span className="t">Stale</span>
          <span className="c">
            The last refresh did not reach the instance. Showing the previous read from {ago(newestRead, now)}.
          </span>
        </div>
      )}

      {loaded && !error && status && watched.length === 0 && (
        <div className="card2">
          <div className="bd" style={{ fontSize: 13.5, color: "var(--text-2)" }}>
            The instance is up and its watchlist is currently empty.
          </div>
        </div>
      )}

      {/* ── Zone 2/3: the fleet — every watched asset as a tile, the demo OFT
              among them and marked as ours; the open tile's full reading
              expands beneath its row. ──────────────────────────────────────── */}
      {assets.length > 0 && (
        <>
          <h2 className="to-sec-lbl" style={{ marginBottom: 8 }}>
            Watched assets · select one for its full reading
          </h2>
          {/* Said HERE, at the fleet's own heading, and not only inside a panel
              a reader has to open first. The default state of this page is the
              collapsed grid: a row of bands and scores with no finding text
              under them reads as "the engine found nothing" unless the page
              says otherwise, and that silence would be the page overclaiming in
              the opposite direction from the one Requirement 2 guards.
              withheldNote() repeats the fact inside each third-party panel with
              that asset's own counts — a different register, not a duplicate. */}
          <p
            style={{
              margin: "0 0 16px",
              maxWidth: 760,
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--text-2)",
            }}
          >
            {WITHHELD_LINE}
          </p>
          {/* Said HERE for the same reason the line above it is: the default
              state of this page is the collapsed grid, and every tile in it now
              carries a dollar figure. A number on a page of scores is read as an
              input to those scores unless the page says otherwise, and this one
              is not — the rule engine reads the configuration and never a price.
              A reader who opens no tile still reads this. */}
          <p
            style={{
              margin: "0 0 16px",
              maxWidth: 760,
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--text-2)",
            }}
          >
            {EXPOSURE_NOTE}
          </p>
          <div
            className="rail-fleet"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {assets.map((w, i) => {
              const key = keyOf(w);
              const demo = isDemo(w);
              const routes = routesOf(w);
              const open = key === openKey;
              return (
                <Fragment key={key}>
                  <FleetTile
                    w={w}
                    demo={demo}
                    routes={routes}
                    open={open}
                    onToggle={() => setOpenKey((prev) => (prev === key ? null : key))}
                    labelId={`tk-${key}`}
                    panelId={`panel-${key}`}
                  />
                  {i === detailAfter && openIndex >= 0 && (
                    <DetailPanel
                      w={assets[openIndex]}
                      demo={isDemo(assets[openIndex])}
                      routes={routesOf(assets[openIndex])}
                      verdicts={verdicts}
                      registry={status?.registry}
                      labelId={`tk-${keyOf(assets[openIndex])}`}
                      panelId={`panel-${keyOf(assets[openIndex])}`}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </>
      )}

      {/* ── Zone 4: footer strip ──────────────────────────────────────────── */}
      <footer className="foot" style={{ marginTop: 48 }}>
        <span style={{ maxWidth: 760, lineHeight: 1.6 }}>{FOOTER_LINE}</span>
        <a className="txlink" href={REPO_URL} target="_blank" rel="noreferrer">
          source repository ↗
        </a>
      </footer>
    </div>
  );
}

export default FlareRailStatus;
