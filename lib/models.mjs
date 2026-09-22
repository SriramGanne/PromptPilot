// Single source of truth for Together AI model IDs. Dependency-free .mjs so
// both the Next.js app and the plain-node scripts can import it.

// GLM-5.3-Flash (320B total / 18B active, MoE). Used for gap analysis,
// synthesis, and refinement — all three must run on the same model.
export const REASONING_MODEL = "zai-org/GLM-5.3-Flash";

// 1024-dim retrieval model. Ingest (passage:) and query (query:) embeddings
// must come from the same model or cosine similarity is meaningless.
export const EMBEDDING_MODEL = "intfloat/multilingual-e5-large-instruct";
export const EMBEDDING_DIM = 1024;
