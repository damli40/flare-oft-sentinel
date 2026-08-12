/**
 * Global test setup. One job: make the suite hermetic.
 *
 * `readSnapshot`'s last-resort fallback is Etherscan's eth_call proxy, and it
 * fires whenever every RPC in the list fails a read on a chain flagged
 * `etherscanFree`. Several fixtures produce exactly that shape on purpose
 * (a handler that models some selectors and answers "0x" to the rest), so with
 * ETHERSCAN_API_KEY present in the ambient environment the suite made LIVE
 * `fetch` calls to api.etherscan.io — each one serialized behind a real 400ms
 * spacer.
 *
 * Two things were wrong with that, beyond the ~3s it cost:
 *
 *  1. "323 tests passing" meant something different on a machine with the key
 *     set than on one without it. The reads the fallback served were the reads a
 *     keyless machine saw fail, so the two runs exercised different code and
 *     asserted over different snapshots. A green run is only evidence if it is
 *     the same run everywhere.
 *  2. A security monitor's test suite must not depend on a third party being up,
 *     rate-limiting us favourably, or returning what it returned last week.
 *
 * Unsetting the key here makes `etherscanCall` reject immediately — the same
 * outcome a keyless machine already had, now the outcome EVERY machine has. The
 * fallback path itself is not thereby left uncovered: it is pinned directly in
 * read-snapshot.test.ts ("Etherscan eth_call fallback"), which stubs both the
 * key and `fetch` so the path runs end to end against an in-process double.
 *
 * A test that wants the key back can `vi.stubEnv("ETHERSCAN_API_KEY", …)`; it
 * must stub `fetch` too, or it is reintroducing exactly this problem.
 */
delete process.env.ETHERSCAN_API_KEY;

/**
 * Same rule, second instance: the Flare scoping vars.
 *
 * `WATCH_CHAINS`, `WATCH_PINNED`, `ATTEST_SCOPE` and `ATTEST_PINNED` are how this build is meant
 * to be RUN locally (`WATCH_CHAINS=flare npm start`), so a developer's shell
 * very plausibly has them exported while they run the suite. They are read at
 * call time by watch-scope, which is exactly what makes them dangerous here:
 * every test that asserts the UNSET default — the full multi-chain fleet, the
 * Mantle demo asset, attest-everything — silently asserts the scoped behavior
 * instead. Measured before this line existed: `WATCH_CHAINS=flare npm test`
 * turned 398 passing into 5 failures in watchlist-health.test.ts, none of them
 * a real defect.
 *
 * Deleting them here makes every machine run the same suite. A test that wants
 * a scope stubs it explicitly (`vi.stubEnv`), which is how attest-scope.test.ts,
 * watch-scope.test.ts and watchlist-scope.test.ts cover the set behavior.
 */
delete process.env.WATCH_CHAINS;
delete process.env.WATCH_PINNED;
delete process.env.ATTEST_SCOPE;
delete process.env.ATTEST_PINNED;

/**
 * Same rule, third instance: ADMIN_TOKEN.
 *
 * The operator routes answer 404 when it is unset — "the route does not exist" —
 * and several tests assert exactly that without stubbing it first, because
 * absence is the default they are pinning. An operator who exported ADMIN_TOKEN
 * in the shell they ran the suite from would turn those 404 assertions red on a
 * build with nothing wrong with it: a green build reported as a broken one, which
 * is the same defect as the two above.
 *
 * A test that wants the gate open stubs it (`vi.stubEnv("ADMIN_TOKEN", …)`), which
 * is how admin-gated-routes.test.ts and declarations-api.test.ts cover both sides.
 */
delete process.env.ADMIN_TOKEN;

/**
 * Same rule, applied to every switch this instance ADDED.
 *
 * The four above were scrubbed because an operator's exported shell value could
 * turn a healthy build red. The Flare port then introduced six more variables with
 * exactly that property and did not scrub them, which is worse than the original
 * problem in one specific way: SENTINEL_CHAIN_ID is read at CALL time by
 * chain-registry.sentinelChain(), and the documented way to run this instance
 * locally is to export SENTINEL_CHAIN_ID=14. So the very configuration the README
 * tells a developer to use silently re-points every test that pins the 5003 /
 * Mantle Sepolia default — and those tests would not fail, they would assert
 * Flare's values while claiming to assert the default. Green, and meaningless.
 *
 * REPING_* matter for the same reason in the other direction: reping-cadence.test.ts
 * pins the 12h / 7d defaults, and an operator tuning the live cadence in their shell
 * would move the numbers under it.
 *
 * A test that wants any of these set stubs it with vi.stubEnv, same as ADMIN_TOKEN.
 */
delete process.env.SENTINEL_CHAIN_ID;
delete process.env.SENTINEL_CHAIN_NAME;
delete process.env.SENTINEL_RPC;
delete process.env.X402_ENABLED;
delete process.env.REPING_CRITICAL_MINUTES;
delete process.env.REPING_AT_RISK_MINUTES;
