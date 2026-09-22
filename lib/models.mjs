// Single source of truth for model IDs. Dependency-free .mjs so both the
// Next.js app and the plain-node scripts can import it.

// Together AI. GLM-5.3-Flash (320B total / 18B active, MoE). Used for gap
// analysis, synthesis, and refinement — all three must run on the same model.
export const REASONING_MODEL = "zai-org/GLM-5.3-Flash";

// OpenAI. Natively 1536-dim; requested at 1024 via the `dimensions` param so
// the pgvector column stays vector(1024). Ingest and query embeddings must
// come from the same model + dimension or cosine similarity is meaningless.
// (Together dropped intfloat/multilingual-e5-large-instruct from serverless
// and its only remaining serverless embedder is 768-dim.)
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1024;
