import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";

/** Bearer-token gate for operator-only routes.
 *
 *  Fails closed in both directions:
 *   - ADMIN_TOKEN unset OR empty  → 404, the route does not exist. An
 *     unconfigured deployment exposes no hint that a write surface is there,
 *     and "unset" can never mean "open".
 *   - token absent or wrong       → 401.
 *
 *  It lives in its own module because it now guards two routers: the custody
 *  declarations API (where it started) and every mutating sentinel route with
 *  no shipped UI caller. One copy, so the two can never drift apart — and a
 *  route added later gates by importing this rather than by re-deriving it.
 *
 *  Comparison is timing-safe; a length mismatch short-circuits before the
 *  compare because timingSafeEqual throws on unequal lengths. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(404).json({ error: "not found" });

  const header = req.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
