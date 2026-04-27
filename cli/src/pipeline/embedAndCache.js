import OpenAI from 'openai';
import { Redis } from '@upstash/redis';
import { getConfig } from '../config.js';

const EMBEDDING_MODEL = 'intfloat/multilingual-e5-large-instruct';
const EXPECTED_EMBED_DIM = 1024;
const CACHE_HASH_KEY = 'promptbuddy:cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.9;

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

function createRedis(config) {
  return new Redis({
    url: config.UPSTASH_REDIS_REST_URL,
    token: config.UPSTASH_REDIS_REST_TOKEN,
  });
}

async function getCachedResult(redis, embedding, targetModel) {
  let allEntries;
  try {
    allEntries = await redis.hgetall(CACHE_HASH_KEY);
  } catch (err) {
    console.warn('Redis HGETALL failed:', err.message);
    return null;
  }

  if (!allEntries) return null;

  const now = Date.now();
  let bestSimilarity = 0;
  let bestPayload = null;

  for (const raw of Object.values(allEntries)) {
    let entry;
    try {
      entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
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

async function pruneExpiredEntries(redis) {
  const allEntries = await redis.hgetall(CACHE_HASH_KEY);
  if (!allEntries) return;
  const now = Date.now();
  const expiredFields = [];
  for (const [field, raw] of Object.entries(allEntries)) {
    try {
      const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (entry.expiresAt < now) expiredFields.push(field);
    } catch {
      expiredFields.push(field);
    }
  }
  if (expiredFields.length > 0) await redis.hdel(CACHE_HASH_KEY, ...expiredFields);
}

/**
 * Embed a raw prompt and check the semantic cache in one call.
 * @param {string} rawPrompt
 * @param {string} targetModel
 * @returns {Promise<{embedding: number[], cacheHit: boolean, cachedResult: object|null}>}
 */
export async function getEmbeddingAndCacheHit(rawPrompt, targetModel) {
  const config = getConfig();

  const together = new OpenAI({
    apiKey: config.TOGETHER_API_KEY,
    baseURL: 'https://api.together.xyz/v1',
  });

  const response = await together.embeddings.create({
    model: EMBEDDING_MODEL,
    input: `query: ${rawPrompt}`,
  });

  const embedding = response.data[0].embedding;
  if (!Array.isArray(embedding) || embedding.length !== EXPECTED_EMBED_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EXPECTED_EMBED_DIM}, got ${embedding?.length ?? 'invalid'}`
    );
  }

  if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) {
    return { embedding, cacheHit: false, cachedResult: null };
  }

  const redis = createRedis(config);
  const cachedResult = await getCachedResult(redis, embedding, targetModel);
  return { embedding, cacheHit: !!cachedResult, cachedResult };
}

/**
 * Write an optimized result to the semantic cache.
 * @param {number[]} embedding
 * @param {string} targetModel
 * @param {object} payload
 */
export async function writeCacheResult(embedding, targetModel, payload) {
  const config = getConfig();
  if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) return;

  const redis = createRedis(config);
  const field = crypto.randomUUID();
  const entry = {
    embedding,
    targetModel,
    payload,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  try {
    await redis.hset(CACHE_HASH_KEY, { [field]: JSON.stringify(entry) });
    pruneExpiredEntries(redis).catch((err) =>
      console.warn('Cache prune failed (non-fatal):', err.message)
    );
  } catch (err) {
    console.warn('Redis HSET failed:', err.message);
  }
}

export { CACHE_HASH_KEY };
