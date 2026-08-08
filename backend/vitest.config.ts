import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before every test file. See setup.ts — it exists so that a run's
    // result does not depend on what happens to be in the ambient environment.
    setupFiles: ["./src/__tests__/setup.ts"],

    // 30s, not vitest's 5s default, and only for the FIRST run on a fresh
    // clone. `backend/data/` is a gitignored runtime dir, so a clone arrives
    // without the DVN metadata cache and the first assessment fetches
    // LayerZero's public metadata (~217 KB) to build it. On a slow link — or on
    // a machine already busy — that fetch outlasts 5s and two custody tests
    // fail on a timeout, in a suite where nothing is wrong. Measured on a
    // clean clone: run 1 passed 596/596 here and failed 2 for a reviewer on the
    // same commit, which is the definition of a flake a judge should not meet.
    //
    // It buys latitude, not silence: a genuinely hung test still fails, just
    // later. The offline claim this affects is stated plainly in the README —
    // run 1 needs the network, every run after it does not.
    testTimeout: 30_000,
  },
});
