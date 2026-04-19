import { createClient } from "@supabase/supabase-js";

/**
 * Shared Supabase client for server-side API routes.
 * Uses service role key — never expose this on the client side.
 */
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =============================================================================
// SUPABASE SCHEMA — run once in the SQL editor before using RAG features
// =============================================================================
//
// -- 1. Enable the pgvector extension
// create extension if not exists vector;
//
// -- 2. Create the research table
//        embedding dimension must match the model output:
//        intfloat/multilingual-e5-large-instruct (Together AI) → 1024 dims
//        NOTE: docs must be embedded with "passage: " prefix at ingest,
//              queries with "query: " prefix at retrieval. See embedQuery()
//              in app/api/orchestrate/route.js and embed() in
//              scripts/ingest_research.mjs.
// create table prompt_research (
//   id          uuid primary key default gen_random_uuid(),
//   title       text not null unique,
//   content     text not null,
//   source_file text,
//   embedding   vector(1024),
//   created_at  timestamptz default now()
// );
//
// -- 3. IVFFlat index for fast approximate nearest-neighbour search
//        Tune `lists` to ~sqrt(row_count) once the table has data.
// create index on prompt_research
//   using ivfflat (embedding vector_cosine_ops)
//   with (lists = 100);
//
// -- 4. Knowledge Vault columns — featured entries surfaced in /vault
//        Run these once as a migration; `if not exists` keeps it idempotent.
// alter table prompt_research add column if not exists summary      text;
// alter table prompt_research add column if not exists best_for     text;
// alter table prompt_research add column if not exists citation_url text;
// alter table prompt_research add column if not exists category     text;   -- Reasoning / Structure / Style
// alter table prompt_research add column if not exists is_featured  boolean default false;
//
// create index if not exists prompt_research_featured_idx
//   on prompt_research (is_featured) where is_featured = true;
//
// -- 5. match_prompt_research — called via supabase.rpc('match_prompt_research')
// create or replace function match_prompt_research(
//   query_embedding  vector(1024),
//   match_threshold  float  default 0.7,
//   match_count      int    default 5
// )
// returns table (
//   id          uuid,
//   title       text,
//   content     text,
//   similarity  float
// )
// language sql stable
// as $$
//   select
//     id,
//     title,
//     content,
//     1 - (embedding <=> query_embedding) as similarity
//   from prompt_research
//   where 1 - (embedding <=> query_embedding) > match_threshold
//   order by similarity desc
//   limit match_count;
// $$;
//
// =============================================================================

/**
 * Search prompt_research for chunks semantically similar to a query embedding.
 *
 * @param {number[]} embedding    - Query vector (must match table dimension: 1024)
 * @param {object}  [opts]
 * @param {number}  [opts.matchCount=5]      - Max rows to return
 * @param {number}  [opts.matchThreshold=0.7] - Minimum cosine similarity (0–1)
 * @returns {Promise<Array<{id, title, content, similarity}>>}
 */
export async function searchResearch(embedding, { matchCount = 5, matchThreshold = 0.7 } = {}) {
  const { data, error } = await supabase.rpc("match_prompt_research", {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
  });

  if (error) throw new Error(`searchResearch RPC failed: ${error.message}`);
  return data ?? [];
}
