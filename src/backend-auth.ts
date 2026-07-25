import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

export function createBackendAuth(expectedDigest: string): RequestHandler {
  if (!DIGEST_PATTERN.test(expectedDigest)) {
    throw new Error(
      "OFFICE_BACKEND_KEY_SHA256 must be a 64-character SHA-256 digest"
    );
  }

  const expected = Buffer.from(expectedDigest, "hex");

  return (req, res, next) => {
    const provided = req.get("X-Office-Backend-Key") ?? "";
    const actual = createHash("sha256").update(provided, "utf8").digest();

    if (!timingSafeEqual(actual, expected)) {
      res.set("Cache-Control", "no-store");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
