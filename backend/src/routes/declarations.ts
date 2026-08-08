import { Router, json, type Request, type Response } from "express";
import cors from "cors";
import { readDeclarations, validateDeclarations, writeDeclarations } from "../services/custody-admin.js";
import { requireAdmin } from "./require-admin.js";

// Operator-only API for the custody declarations file. Mounted BEFORE the
// app-level origin-restricted CORS: the bearer token is the security boundary
// here (no cookies), and a locally-served editor page must be able to reach a
// deployed backend without widening CORS_ORIGINS for the whole app.
export const router = Router();

router.use(cors());
router.use(json());

// requireAdmin (./require-admin.ts): when ADMIN_TOKEN is unset the API does not
// exist — 404, not 401 — so an unconfigured deployment exposes no hint that a
// write surface is available.

router.get("/", requireAdmin, (_req: Request, res: Response) => {
  res.json(readDeclarations());
});

// Full-file replace. PUT {} is the removal path.
router.put("/", requireAdmin, (req: Request, res: Response) => {
  // Without this guard, a PUT missing the JSON content-type parses to {} and
  // would silently wipe every declaration.
  if (!req.is("application/json")) {
    return res.status(400).json({ error: "content-type must be application/json" });
  }
  const reason = validateDeclarations(req.body);
  if (reason) return res.status(400).json({ error: reason });

  writeDeclarations(req.body);
  res.json(req.body);
});
