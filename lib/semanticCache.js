import { Redis } from "@upstash/redis";
import { EMBEDDING_MODEL, EMBEDDING_DIM } from "./models.mjs";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Namespaced by embedding model so vectors from a previous embedder can never
// be compared against current ones — cosine across models is meaningless.
// Bump when retrieval policy/catalogue changes, so old retired sources are not
// served from cached generations. No destructive Redis flush is needed.
const CACHE_HASH_KEY = `promptbuddy:cache:${EMBEDDING_MODEL}-${EMBEDDING_DIM}:vault-hybrid-2026-09`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Calibrated for text-embedding-3-small: a paraphrased intent scores ~0.80
// against the original, a different task sharing most words ~0.76. Set just
// above the paraphrase so borderline cases miss (a miss only costs a fresh
// generation; a false hit serves the wrong prompt).
const SIMILARITY_THRESHOLD = 0.82;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1]; higher = more similar.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Cache API
// ---------------------------------------------------------------------------

/**
 * Look up a semantically similar cached result.
 *
 * Retrieves all entries from the Redis hash, filters to the same targetModel
 * and non-expired entries, then returns the highest-similarity match above
 * SIMILARITY_THRESHOLD. Returns null on a miss.
 *
 * @param {number[]} embedding   - Query embedding (1024 dims)
 * @param {string}  targetModel  - Must match the cached model (Claude / ChatGPT / …)
 * @returns {Promise<object | null>}  Cached payload with cacheHit + similarity added
 */
export async function getCachedResult(embedding, targetModel) {
  let allEntries;
  try {
    allEntries = await redis.hgetall(CACHE_HASH_KEY);
  } catch (err) {
    console.warn("Redis HGETALL failed:", err.message);
    return null;
  }

  if (!allEntries) return null;

  const now = Date.now();
  let bestSimilarity = 0;
  let bestPayload = null;

  for (const raw of Object.values(allEntries)) {
    let entry;
    try {
      entry = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }

    if (entry.expiresAt < now) continue;
    if (entry.targetModel !== targetModel) continue;
    if (!Array.isArray(entry.embedding)) continue;

    const similarity = cosineSimilarity(embedding, entry.embedding);

    if (similarity >= SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestPayload = { ...entry.payload, cacheHit: true, cacheSimilarity: similarity };
    }
  }

  return bestPayload;
}

/**
 * Write a new result to the semantic cache.
 *
 * Stores the entry in the Redis hash under a random UUID field key, with an
 * `expiresAt` timestamp for logical TTL. Also triggers a lightweight pruning
 * pass on every write to prevent the hash from growing unboundedly.
 *
 * @param {number[]} embedding   - The embedding that was used to produce this result
 * @param {string}  targetModel
 * @param {object}  payload      - The full API response object to cache
 * @returns {Promise<void>}
 */
export async function setCachedResult(embedding, targetModel, payload) {
  const field = crypto.randomUUID();
  const entry = {
    embedding,
    targetModel,
    payload,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  try {
    await redis.hset(CACHE_HASH_KEY, { [field]: JSON.stringify(entry) });
    // Best-effort: prune expired entries after every write so the hash stays lean
    pruneExpiredEntries().catch((err) =>
      console.warn("Cache prune failed (non-fatal):", err.message)
    );
  } catch (err) {
    // Cache write failure must never break the main request
    console.warn("Redis HSET failed:", err.message);
  }
}

/**
 * Remove entries whose expiresAt has passed. Runs fire-and-forget after writes.
 */
async function pruneExpiredEntries() {
  const allEntries = await redis.hgetall(CACHE_HASH_KEY);
  if (!allEntries) return;

  const now = Date.now();
  const expiredFields = [];

  for (const [field, raw] of Object.entries(allEntries)) {
    try {
      const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (entry.expiresAt < now) expiredFields.push(field);
    } catch {
      expiredFields.push(field); // malformed — remove it
    }
  }

  if (expiredFields.length > 0) {
    await redis.hdel(CACHE_HASH_KEY, ...expiredFields);
  }
}
