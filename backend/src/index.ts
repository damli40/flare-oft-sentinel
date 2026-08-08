import "dotenv/config";
import express from "express";
import cors from "cors";
import { router as mantleRouter } from "./routes/mantle.js";
import { router as sentinelRouter } from "./routes/sentinel.js";
import { router as declarationsRouter } from "./routes/declarations.js";
import { startSentinel } from "./services/sentinel.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

// Behind Railway's proxy, req.ip must reflect the client (rate limiting), not the LB.
app.set("trust proxy", 1);

// Token-gated (404 when ADMIN_TOKEN unset). Mounted before the origin-restricted
// CORS below on purpose — see routes/declarations.ts.
app.use("/api/sentinel/declarations", declarationsRouter);

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:5173", "http://localhost:4173"];
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

app.use("/api/mantle", mantleRouter);
app.use("/api/sentinel", sentinelRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);

  // The Sentinel runs autonomously — always on, unless explicitly disabled.
  //
  // SENTINEL_AUTOSTART=false serves the API without the poller. This exists because
  // pollOnce() is NOT a read-only operation: it calls attest() (real gas from
  // SENTINEL_PRIVATE_KEY) and dispatchAlert() (public Telegram + on-chain AlertBus), and
  // its weakAlertFired dedupe is an in-memory Set that resets every process — so booting
  // the server locally to "just check an endpoint" re-attests and re-alerts the entire
  // fleet. Opt-out rather than opt-in: prod must never silently stop monitoring because
  // an env var went missing.
  if (process.env.SENTINEL_AUTOSTART === "false") {
    console.log("[server] poller DISABLED (SENTINEL_AUTOSTART=false) — API only, no attestations, no alerts");
    return;
  }
  startSentinel();
});
