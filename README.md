# PromptBuddy

A high-end Prompt Engineering Agent that transforms raw intent into production-ready prompts using an agentic RAG pipeline, semantic caching, and 2026 reasoning markers.

## Architecture

```
POST /api/orchestrate
        │
        ▼
  Gap Analysis (Gemma 3 27B)
  → clarityScore < 0.7 → return { status: "clarifying", questions }
        │
        ▼
  Embed query (BAAI/bge-large-en-v1.5, 1024 dims)
        │
        ├─► Semantic Cache lookup (Upstash Redis, similarity > 0.9)
        │   └── HIT → return cached response immediately
        │
        ▼ MISS
  RAG Retrieval (Supabase pgvector / match_prompt_research)
        │
        ▼
  Synthesis (Gemma 3 27B) with <thinking>, <context_grounding>, <eval_prediction>
        │
        ▼
  Faithfulness Score (simplified Ragas: output ∩ context / output keywords)
        │
        ├─► Write to Redis cache (24h TTL)
        └─► Log to Supabase prompt_metrics (fire-and-forget)
```

## Environment Variables

Create a `.env.local` file at the project root with the following variables:

```env
# ── Together AI ────────────────────────────────────────────────────────────────
# Powers the Gemma 3 reasoning model and BAAI embedding model.
# Get your key at: https://api.together.xyz/settings/api-keys
TOGETHER_API_KEY=

# ── Supabase ───────────────────────────────────────────────────────────────────
# Used for vector similarity search (pgvector) and prompt_metrics logging.
# Get these from: https://supabase.com/dashboard/project/<your-project>/settings/api
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=       # Server-side only — never expose to the browser

# Public keys — safe to expose, used by client-side Supabase calls if any
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# ── Upstash Redis ──────────────────────────────────────────────────────────────
# Powers the semantic cache (cosine similarity > 0.9, 24h TTL).
# Create a Redis database at: https://console.upstash.com
# Copy the REST URL and token from the database detail page.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

## Supabase Schema

Run the following SQL once in your Supabase SQL editor before using RAG features.
The full annotated schema is also in [`lib/supabase.js`](lib/supabase.js) as comments.

```sql
-- Enable pgvector
create extension if not exists vector;

-- Research table (dimension must match BAAI/bge-large-en-v1.5 → 1024)
create table prompt_research (
  id          uuid primary key default gen_random_uuid(),
  title       text not null unique,
  content     text not null,
  source_file text,
  embedding   vector(1024),
  created_at  timestamptz default now()
);

create index on prompt_research
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Match function called by searchResearch() in lib/supabase.js
create or replace function match_prompt_research(
  query_embedding  vector(1024),
  match_threshold  float  default 0.7,
  match_count      int    default 5
)
returns table (id uuid, title text, content text, similarity float)
language sql stable as $$
  select id, title, content, 1 - (embedding <=> query_embedding) as similarity
  from prompt_research
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;
```

## Ingesting Research

Populate the RAG knowledge base from a Markdown file of prompting best practices.
The file is split on `##` headings — each section becomes one row.

```bash
node --env-file=.env.local scripts/ingest_research.mjs data/best_practices.md
```

Re-running is idempotent: rows are upserted on `title`.

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## API Response Shapes

**Clarifying** (input lacks sufficient detail):
```json
{
  "status": "clarifying",
  "clarityScore": 0.45,
  "missingDimensions": ["target_audience", "output_format"],
  "questions": ["Who is the target audience?", "What output format do you need?"]
}
```

**Optimized** (fresh LLM call):
```json
{
  "status": "optimized",
  "cacheHit": false,
  "optimizedPrompt": "<thinking>…</thinking>\n<context_grounding>…</context_grounding>\n### PROMPT START\n…\n### PROMPT END\n<eval_prediction>…</eval_prediction>",
  "faithfulnessScore": 0.82,
  "ragSources": [{ "title": "Chain-of-Thought Prompting", "similarity": 0.91 }],
  "clarityScore": 0.85,
  "originalTokens": 14,
  "optimizedTokens": 210,
  "reductionPercent": -1400,
  "targetModel": "Claude"
}
```

**Cache hit** (semantically similar prompt seen within 24h):
```json
{
  "status": "optimized",
  "cacheHit": true,
  "cacheSimilarity": 0.96,
  "optimizedPrompt": "…",
  "…": "…"
}
```
