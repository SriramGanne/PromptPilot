import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "./semanticCache";

/**
 * Per-IP rate limiter for the public orchestration endpoint.
 *
 * Every /api/orchestrate call fans out to 2 LLM calls + 1 embedding + Supabase
 * + Upstash. Without rate limiting, a single client can drain all three quotas
 * in minutes and run up large Together AI bills. The sliding-window limiter is
 * the standard mitigation — it's cheap (one Redis round-trip per request) and
 * fails closed.
 *
 * Windows picked for a public LinkedIn/X launch:
 *   - 10 req / 60 s per IP   → bursts from an excited user are fine; bots die
 *   - 60 req / 24 h per IP   → a daily ceiling so a persistent attacker at
 *                              1 req/min still can't exceed the free-tier quotas
 *
 * Prefix intentionally namespaced separately from the semantic cache hash,
 * so flushing rate-limit state never touches cached optimizations.
 */
export const burstLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "60 s"),
  analytics: true,
  prefix: "promptpilot:ratelimit:burst",
});

export const dailyLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, "24 h"),
  analytics: true,
  prefix: "promptpilot:ratelimit:daily",
});

/**
 * Best-effort client IP extraction from Next.js request headers. In order:
 *   1. x-forwarded-for (first value — the original client, not the proxy chain)
 *   2. x-real-ip (set by nginx/Vercel edge)
 *   3. "anonymous" sentinel — rare, means we couldn't identify the caller;
 *      lumping them together is safer than letting them bypass the limit
 *
 * @param {Request} request
 * @returns {string}
 */
export function getClientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "anonymous";
}

/**
 * Enforce both limiters in sequence. Returns { ok: true } on pass, or
 * { ok: false, retryAfterSec, scope } on block. Scope identifies which
 * window tripped — useful for the 429 body so clients can differentiate
 * "slow down" from "come back tomorrow".
 *
 * @param {string} ip
 * @returns {Promise<{ok: true} | {ok: false, retryAfterSec: number, scope: "burst"|"daily"}>}
 */
export async function enforceRateLimit(ip) {
  const burst = await burstLimiter.limit(ip);
  if (!burst.success) {
    const retryAfterSec = Math.max(1, Math.ceil((burst.reset - Date.now()) / 1000));
    return { ok: false, retryAfterSec, scope: "burst" };
  }
  const daily = await dailyLimiter.limit(ip);
  if (!daily.success) {
    const retryAfterSec = Math.max(1, Math.ceil((daily.reset - Date.now()) / 1000));
    return { ok: false, retryAfterSec, scope: "daily" };
  }
  return { ok: true };
}
