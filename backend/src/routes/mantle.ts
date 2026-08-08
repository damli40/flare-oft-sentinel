import { Router } from "express";
import type { Request, Response } from "express";
import { getMantleOfts, MANTLE_OFT_QUERY_ID } from "../services/dune.js";

export const router = Router();

const LEADERBOARD_MIN_VOLUME = 1_000_000;

// GET /api/mantle/ofts  — all-time OFTs with ≥$1M volume, sorted by USD volume.
// ?refresh=true bypasses the in-memory cache.
router.get("/ofts", async (req: Request, res: Response) => {
  try {
    const force = req.query.refresh === "true";
    const all = await getMantleOfts(force);
    const ofts = all.filter(o => o.usdVolume >= LEADERBOARD_MIN_VOLUME);
    res.json({
      queryId: MANTLE_OFT_QUERY_ID,
      source: "https://dune.com/queries/" + MANTLE_OFT_QUERY_ID,
      count: ofts.length,
      ofts,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(502).json({ error: message });
  }
});
