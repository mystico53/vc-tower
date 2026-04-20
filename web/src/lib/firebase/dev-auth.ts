import { env } from "@/lib/env";

// Dev-only harness auth. Both gates must pass:
//   1. NODE_ENV !== "production"  — hard refuse on prod servers.
//   2. HARNESS_DEV_KEY env var set AND x-dev-key header matches it.
//
// Designed so that a stray `next start` in production still refuses, and a
// dev server without HARNESS_DEV_KEY configured also refuses.
export function verifyDevHarnessAuth(
  req: Request,
): { ok: true } | { ok: false; status: number; error: string } {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 403, error: "harness disabled in production" };
  }
  const expected = env.HARNESS_DEV_KEY;
  if (!expected) {
    return { ok: false, status: 500, error: "HARNESS_DEV_KEY not configured" };
  }
  const got = req.headers.get("x-dev-key") ?? req.headers.get("X-Dev-Key");
  if (!got || got !== expected) {
    return { ok: false, status: 401, error: "invalid x-dev-key" };
  }
  return { ok: true };
}
