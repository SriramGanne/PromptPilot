# PromptPilot — Architecture

## System Overview

PromptPilot runs as an **MCP (Model Context Protocol) stdio server** that intercepts every user prompt before Claude responds. It is wired into Claude Code via `CLAUDE.md` — Claude is instructed to call `optimize_prompt` before acting on any user message.

---

## Full Pipeline Diagram

```mermaid
flowchart TD
    User(["👤 User\nraw prompt"])
    ClaudeCode["Claude Code\n(CLAUDE.md hook)"]
    MCPEntry["MCP Server\noptimize_prompt tool\nmcp-server.js"]

    User -->|raw message| ClaudeCode
    ClaudeCode -->|"optimize_prompt(rawPrompt, targetModel)"| MCPEntry

    MCPEntry --> Triage{"Word count\n< 6?"}
    Triage -->|Yes| Skip(["⚡ skipped: true\nreturn raw prompt"])
    Triage -->|No| GapAnalysis

    subgraph GapAnalysis["① Gap Analysis — gapAnalysis.js"]
        direction TB
        GAModel["Gemma 3n-E4B-it\nvia Together AI"]
        GACheck{"clarityScore\n≥ 0.7?"}
        GAModel --> GACheck
    end

    GapAnalysis -->|No — insufficient| Clarify(["❓ needsClarification: true\nreturn questions array"])
    GapAnalysis -->|Yes — sufficient| Embed

    subgraph Embed["② Embed & Semantic Cache — embedAndCache.js"]
        direction TB
        EmbedModel["multilingual-e5-large-instruct\n1024-dim via Together AI\n(query: prefix)"]
        Redis["Upstash Redis\nHGETALL promptbuddy:cache\ncosine similarity ≥ 0.9\n24h TTL"]
        CacheHit{"Cache\nhit?"}
        EmbedModel --> Redis --> CacheHit
    end

    CacheHit -->|Yes| CachedResult(["✅ cacheHit: true\nreturn cached optimizedPrompt"])
    CacheHit -->|No| RAG

    subgraph RAG["③ RAG Retrieval — ragRetrieval.js"]
        direction TB
        SupabaseRPC["Supabase pgvector\nmatch_prompt_research RPC\nthreshold 0.65 · top-3 chunks"]
        Citations["Enrich with citation_url\nfrom prompt_research table"]
        SupabaseRPC --> Citations
    end

    RAG --> Synthesis

    subgraph Synthesis["④ Synthesis — synthesis.js"]
        direction TB
        SysPrompt["Build system message\nPromptPilot base prompt\n+ model hints (Claude/GPT/Gemini/Grok)\n+ RAG context blocks"]
        SynthModel["Gemma 3n-E4B-it\nvia Together AI\ntemp 0.4 · max 1800 tokens"]
        Extract["Extract ### PROMPT START…END\nCompute faithfulness score\n(RAG word overlap)"]
        SysPrompt --> SynthModel --> Extract
    end

    Extract --> WriteCache["Write to Upstash Redis\n(embedding + payload, 24h TTL)"]
    Extract --> LogMetrics["Log to Supabase\nprompt_metrics table\n(tokens, faithfulness, reduction %)"]
    Extract --> Return

    Return(["optimizedPrompt\nclarityScore · ragSources\nfaithfulnessScore · tokenStats"])
    Return --> ClaudeCode
    ClaudeCode -->|acts on optimized prompt| Response(["💬 Response to User"])
```

---

## Component Responsibilities

| File | Stage | External Service |
|---|---|---|
| `mcp-server.js` | Entry point, routing, fallback | — |
| `pipeline/gapAnalysis.js` | ① Clarity scoring, question generation | Together AI (Gemma 3n) |
| `pipeline/embedAndCache.js` | ② Embedding + semantic cache read/write | Together AI (e5-large), Upstash Redis |
| `pipeline/ragRetrieval.js` | ③ Vector similarity search + citation lookup | Supabase (pgvector) |
| `pipeline/synthesis.js` | ④ Prompt optimization, faithfulness scoring, metrics | Together AI (Gemma 3n), Supabase |

---

## Data Flow Summary

```
User prompt
  → [word count < 6?] → skip (return raw)
  → Gap Analysis (Gemma 3n) → [clarity < 0.7?] → return clarification questions
  → Embed (e5-large-instruct, 1024-dim)
  → Semantic Cache (Upstash Redis, cosine ≥ 0.9) → [hit?] → return cached result
  → RAG Retrieval (Supabase pgvector, top-3 chunks @ 0.65)
  → Synthesis (Gemma 3n + RAG context + model hints)
  → Write cache (24h TTL) + log metrics
  → Return optimizedPrompt to Claude
```

---

## Fallback Guarantee

If **any** stage throws an error, `mcp-server.js` catches it and returns:

```json
{ "optimizedPrompt": "<original raw prompt>", "fallback": true }
```

Claude always receives a usable response — the pipeline failure is never surfaced to the user.

---

## External Services

| Service | Purpose | Config Key |
|---|---|---|
| Together AI | Gemma 3n inference (gap analysis + synthesis), e5 embeddings | `TOGETHER_API_KEY` |
| Supabase | pgvector RAG knowledge vault + prompt metrics logging | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Upstash Redis | Semantic cache (cosine similarity, 24h TTL) | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
