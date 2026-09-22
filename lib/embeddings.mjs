import OpenAI from "openai";
import { EMBEDDING_MODEL, EMBEDDING_DIM } from "./models.mjs";

// Single embedding path for ingest, curation, and query-time retrieval. All
// three MUST go through here: vectors from different models (or different
// dimension settings) are not comparable, and a mismatch silently degrades
// cosine similarity into noise rather than failing loudly.

let client;

export async function embedText(text) {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIM,
  });
  const vec = response.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vec?.length ?? "invalid"}`
    );
  }
  return vec;
}
