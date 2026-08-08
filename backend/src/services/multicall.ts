import { encodeFunctionData, decodeAbiParameters, type Address } from "viem";

/**
 * Multicall3 — canonical deployment address, identical on every chain that has it.
 * Verified deployed on ethereum (1), base (8453) and mantle (5000) on 2026-07-19.
 */
export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/**
 * Parse an env-supplied positive integer, or throw.
 *
 * These values gate batching and concurrency. A typo that silently becomes NaN
 * or 0 does not fail — it produces empty or truncated result sets, which read
 * downstream as "nothing to report" and suppress findings. Failing at import
 * is the safe direction: a process that will not start cannot mis-report.
 *
 * Blank is the one exception, and it is a different kind of input. A bare
 * `MULTICALL_CHUNK_SIZE=` in a .env file, or an env var cleared to "" in the
 * Railway dashboard, carries no value and no typo — it is an empty field, not a
 * wrong one. This runs as a production monitor, so refusing to boot on an empty
 * field is the worse outcome: the default is known-good and documented, and a
 * running monitor on defaults beats a dead one. Whitespace-only is treated the
 * same, since a value of " " survives copy-paste and shell quoting unnoticed.
 *
 * A genuinely malformed value ("abc", "0", "-1", "2.5") still throws. Those say
 * someone meant something specific and got it wrong, and guessing past a typo is
 * how a 5000-call chunk size or a concurrency of 0 reaches production unnoticed.
 *
 * `max` extends that to values that parse fine and are still wrong — see
 * MULTICALL_CHUNK_SIZE. It REJECTS rather than clamps, for the same reason "0"
 * throws: silently substituting a working number for the one an operator wrote
 * is guessing past their intent, and a monitor running on a config nobody chose
 * is the failure this whole function exists to make loud.
 */
function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  max?: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  if (max !== undefined && n > max) {
    throw new Error(
      `${name} must be <= ${max}, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Hard ceiling on sub-calls per aggregate3.
 *
 * The bound is a SAFETY bound, not a performance one. Every sub-call in a batch
 * spends gas inside one `eth_call`, and nodes cap that call's gas. Past the cap
 * the node does not reject the request — aggregate3 keeps `allowFailure: true`,
 * so the sub-calls that ran out come back `success: false` with empty
 * returnData, which is indistinguishable from a revert. That is a TRANSPORT
 * failure wearing the one costume the safety invariant forbids: the caller reads
 * it as "the chain said no" and maps it to a null it believes it asked for, when
 * in fact the question was never answered. The larger the chunk, the more of a
 * batch can vanish that way at once.
 *
 * 500 leaves an order of magnitude of headroom over the default of 50 for anyone
 * tuning throughput, while staying far below the size at which a typical 50M
 * eth_call gas cap starts truncating a batch of config reads (~50k gas each).
 * Unreachable at the default; the point is that it is not reachable by a typo
 * either.
 */
export const MULTICALL_CHUNK_MAX = 500;

/** Default sub-calls per batch. Bounds both the node's eth_call gas exposure
 *  and the per-request payload size. */
export const MULTICALL_CHUNK_SIZE = parsePositiveInt(
  "MULTICALL_CHUNK_SIZE",
  process.env.MULTICALL_CHUNK_SIZE,
  50,
  MULTICALL_CHUNK_MAX,
);

export type Call = { target: Address; callData: string };
export type CallResult = { success: boolean; returnData: string };

const AGGREGATE3_ABI = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/**
 * Derived from the ABI above rather than re-declared. Two hand-written copies of
 * one wire format can drift; a decoder that disagrees with the encoder about
 * field order misattributes every result it returns.
 */
const RESULT_PARAMS = AGGREGATE3_ABI[0].outputs;

/**
 * allowFailure is ALWAYS true. This codebase treats a revert as meaningful signal
 * (unreadable ULN config, dormant corridor, blocked pathway); `aggregate` would
 * revert the whole batch and destroy exactly the information the engine reads.
 */
export function encodeAggregate3(calls: Call[]): string {
  return encodeFunctionData({
    abi: AGGREGATE3_ABI,
    functionName: "aggregate3",
    args: [calls.map((c) => ({
      target: c.target,
      allowFailure: true,
      callData: c.callData as `0x${string}`,
    }))],
  });
}

export function decodeAggregate3(returnData: string): CallResult[] {
  const [rows] = decodeAbiParameters(RESULT_PARAMS, returnData as `0x${string}`);
  return (rows as readonly { success: boolean; returnData: string }[]).map((r) => ({
    success: r.success,
    returnData: r.returnData,
  }));
}

export function chunk<T>(items: T[], size: number): T[][] {
  // `size <= 0` alone is not enough, because NaN fails every comparison:
  // `NaN <= 0` is false, so NaN slipped through and `i += NaN` never advanced
  // past the first iteration — chunk(items, NaN) returned [[]], and the caller
  // then made zero RPC calls and reported zero results for N inputs. A
  // fractional size is the milder cousin: chunk([1,2,3], 0.5) yields
  // [[],[1],[],[2],[],[3]], spending an empty round-trip per empty chunk.
  // Require a positive integer outright, matching mapLimit's Number.isFinite
  // guard below.
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be positive integer, got ${String(size)}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run `calls` through Multicall3 using the supplied raw-call function, chunked.
 * Takes a call function rather than a client so this module stays free of any
 * RPC-client dependency.
 *
 * Returns one entry per input call, in input order: the data string, or null
 * where that sub-call reverted or returned nothing.
 *
 * THROWS on transport failure. That distinction is load-bearing: callers must
 * be able to tell "the chain said no" (null) from "we failed to ask" (throw).
 * Collapsing the two would let a rate limit read as a revert and suppress a
 * finding.
 */
export async function aggregate3Batch(
  call: (to: Address, data: string) => Promise<string>,
  calls: Call[],
  chunkSize: number = MULTICALL_CHUNK_SIZE,
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const part of chunk(calls, chunkSize)) {
    const raw = await call(MULTICALL3_ADDRESS, encodeAggregate3(part));
    if (!raw || raw === "0x") throw new Error("empty multicall result");
    const rows = decodeAggregate3(raw);
    // Result index i must correspond to input call i. A short response would
    // truncate and a long one would over-fill, shifting every finding onto the
    // wrong call. We cannot tell which rows are the wrong ones, so we refuse the
    // whole batch: that routes to the caller's transport-failure path ("we failed
    // to ask"), which is the safe direction.
    if (rows.length !== part.length) {
      throw new Error(
        `multicall returned ${rows.length} results for ${part.length} calls`,
      );
    }
    for (const r of rows) {
      out.push(r.success && r.returnData && r.returnData !== "0x" ? r.returnData : null);
    }
  }
  // Assert the postcondition this function's docstring promises ("one entry per
  // input call, in input order"). The per-chunk check above is chunk-local and
  // passes vacuously when there are no chunks at all (0 === 0), so it cannot
  // catch a chunker that dropped every input. Anything that makes out.length
  // disagree with calls.length has silently lost or invented reads, and a lost
  // read reads downstream as "nothing to report".
  if (out.length !== calls.length) {
    throw new Error(
      `multicall produced ${out.length} results for ${calls.length} calls`,
    );
  }
  return out;
}

/** Bounded-concurrency map. The fallback paths use this instead of a bare
 *  Promise.all so that a failing batch degrades gracefully rather than
 *  reintroducing the unbounded fan-out this whole change exists to remove. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // A limit of 0, a negative, or NaN spawns zero workers; Promise.all([]) then
  // resolves immediately and we hand back a pre-allocated array of `undefined`
  // with the right length and no RPC ever made. That is the exact silent-wrong-
  // answer shape this module exists to prevent, so it throws instead.
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`mapLimit concurrency must be >= 1, got ${limit}`);
  }
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Concurrency for fallback (non-batched) reads. */
export const FALLBACK_CONCURRENCY = parsePositiveInt(
  "FALLBACK_CONCURRENCY",
  process.env.FALLBACK_CONCURRENCY,
  4,
);
