# @oft-sentinel/mcp

**Six read-and-validate tools so an agent can check a cross-chain token's
security configuration before it acts on one.**

An OFT (omnichain fungible token) is as safe as a configuration almost nobody
reads: which verifiers must sign off on a message, which libraries carry it, how
many block confirmations a route waits for. A route that one verifier can
approve alone is a route that one compromised verifier can forge a message on,
and nothing about the token looks different from the outside. The check has to
be something a machine performs on demand.

This server wraps the Flare instance of [OFT
Sentinel](https://flare-oft-sentinel.netlify.app/flare.html). An agent can read
any watched OFT's per-corridor DVN configuration, validate a proposed
configuration against the same deterministic rule engine that produces
Sentinel's attestations, and check an attestation against the chain rather than
against our word for it.

It cannot deploy, sign, bridge or write anything. **No write tools exist**, and
the server never handles a private key.

## Tools

| Tool | When an agent uses it |
|------|----------------------|
| `list_fleet` | First call: find an asset's address and chain, filter by chain or risk band |
| `get_oft_config` | Read one OFT's per-corridor DVN sets, thresholds and effective counts |
| `get_verdict` | Current score, risk band, reasons and remediation, plus the last attested verdict |
| `get_drift_history` | When the configuration changed, and what was attested about it |
| `verify_attestation` | Recompute the policy decision record hash locally and compare it against the AuditRegistry on Flare Mainnet. Does not trust the backend |
| `validate_config` | Pre-flight a proposed configuration against the rule engine before shipping it. It refuses nothing, and it says DO NOT SHIP on CRITICAL |

All six carry `readOnlyHint: true`. Outputs are distilled for token economy, so
nothing here proxies a raw backend payload.

These tools read the API, and the API does not filter. Finding text and DVN
operator names come back for every watched asset, while the rail status page
shows them for the demo OFT alone. That difference is deliberate, and the
repository root README explains it.

## Install and run

```bash
cd mcp && npm ci && npm run build   # writes dist/index.js, a stdio server
```

**Claude Code:**

```bash
claude mcp add oft-sentinel -- node /abs/path/to/flare-oft-sentinel/mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "oft-sentinel": {
      "command": "node",
      "args": ["/abs/path/to/flare-oft-sentinel/mcp/dist/index.js"]
    }
  }
}
```

With no environment set, the server reads this repository's own deployment and
verifies attestations on Flare Mainnet. Start with `list_fleet`.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `SENTINEL_API_URL` | `https://flare-sentinel-api-production.up.railway.app` | The Sentinel instance to read from |
| `SENTINEL_REGISTRY_RPC` | `https://flare-api.flare.network/ext/C/rpc` | Flare Mainnet RPC for the attestation read. Set it from the environment only. It is deliberately not a tool input |

The RPC is env-only for a reason. If an agent could name the endpoint, it could
point the verification read at a node that returns whatever hash suits it, and
the independent check would confirm the backend against a source the agent
picked. Operators choose the endpoint; the model asking the question never does.

## Trust model

`verify_attestation` is the reason to believe the rest. It recomputes
`keccak256(JSON.stringify(pdr))` locally from the policy decision record, then
compares that hash against the one the backend stored **and** the one held by
the `AuditRegistry` contract on Flare Mainnet. The registry address comes from
the backend's `/status`, so pointing `SENTINEL_API_URL` at another instance
verifies that instance's registry rather than this one's. A `MISMATCH` comes
back as a normal result, because it is a finding about the backend, which is the
point of running the check at all.

**What a judge will find today: the registry holds zero attestations.** This
instance signs a verdict for every asset it watches, and it signs on a change. No
watched asset has changed since the instance captured its baselines, so there is
nothing to write. `total()` on the registry returns 0, and no watched asset
carries an attestation id, so `verify_attestation` answers `no attested verdict
exists for <ticker>` for every asset in the fleet right now. The tool runs; there
is nothing yet for it to confirm. Read `total()` off the chain rather than off
this paragraph. The other five tools read live data and are unaffected.

`validate_config` is a pure call. The rule engine scores the configuration you
hand it, stores nothing, and touches no chain. The same request gives the same
answer whatever the server has seen before, which is what makes it safe to run
before a deployment rather than after one.

## v1 boundary

No writes, no keys, no deploys, no bridging. Read tools stay read tools. A
version that emits a `setConfig` transaction for a human or an agent to inspect
is on the roadmap in the repository root README, and adding one would be an
announced change rather than a silent one.
