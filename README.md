# PromptPilot 🚀
**Bridging the Gap Between Raw Intent and Production-Ready Prompts.**

PromptPilot is an advanced, research-grounded Prompt Engineering Agent designed for non-technical professionals. It eliminates the "trial-and-error" loop of working with LLMs by using an agentic reasoning workflow to transform vague thoughts into structured, high-performance instructions.

---

## 🎯 The Problem
Most professional users struggle with **Instruction Drift** and **Prompt Ambiguity**. While frontier models are powerful, they require specific structural markers (XML, CoT, Delimiters) to perform consistently. PromptPilot acts as the "Navigator," translating simple language into the technical "handshake" LLMs require.

## ✨ Key Product Features
* **Agentic Interviewer:** Uses a "Gap Analysis" logic to identify missing variables (Context, Persona, Format) and asks targeted follow-up questions before generating.
* **Knowledge Vault (RAG):** A curated, versioned collection spanning foundational and current prompt-engineering research — from *Chain-of-Thought* (2022) through automatic prompt optimization (*MIPRO*, *TextGrad*, *GEPA*). Records carry lifecycle state, so superseded or model-dependent techniques are archived with their provenance rather than deleted, and never reach retrieval.
* **Asymmetric Reasoning:** Powered by **GLM-5.3-Flash**, a 320B-parameter Mixture-of-Experts model (18B active) delivering high-density logic at low latency.
* **Review details:** Shows the model's reasoning trace, quality scores, and papers it cites for the final prompt.
* **Model-Aware Optimization:** Tailors output structure specifically for the target model (ChatGPT, Claude, Gemini, or Grok).
* **Draft-First Delivery:** The optimized prompt appears as soon as it is drafted — readable and copyable while the quality check runs in the background. A stage stepper shows which step is active and how long it has taken.

---

## 🏗️ Technical Architecture


### The Intelligence Stack
* **Core Logic:** `zai-org/GLM-5.3-Flash` (MoE, 320B total / 18B active parameters, optimized for latency-to-logic efficiency).
* **Vector Database:** `Supabase (pgvector)` storing 1024-dimension embeddings.
* **Embedding Model:** OpenAI `text-embedding-3-small` at 1024 dimensions (shared by ingest, curation, and query-time retrieval via `lib/embeddings.mjs`).
* **Semantic Cache:** `Upstash Redis` — cosine-matched on the raw-intent embedding, so paraphrases of a previous request return instantly.
* **Evaluator:** OpenAI `gpt-5-mini` as LLM-as-a-judge, on a separate client from the optimizer so the grader never shares weights with the model it grades.
* **Rate Limiting:** `Upstash Ratelimit` — 10 requests/minute and 60/day per IP.

### Evaluator-Optimizer Design Pattern
PromptPilot doesn't just "guess." It follows a closed-loop system:
1.  **Retrieval:** A HyDE-style rewrite supplies the semantic signal. Hybrid retrieval combines cosine similarity with BM25F lexical evidence from the original user intent across the active vault, then supplies qualifying whole records in relevance order within an 8,000-character research-context budget.
2.  **Gap Analysis:** Scores the intent's clarity and, when it is too vague, asks up to three targeted follow-up questions instead of guessing.
3.  **Synthesis:** GLM-5.3-Flash generates the "Improved Prompt" (V1), which is streamed to the user as a draft.
4.  **Audit:** `gpt-5-mini` grades V1 on five 0–10 metrics (intent fidelity, technique use, constraint adherence, task success, output quality) plus a 0–100 composite.
5.  **Refinement:** If any gated metric falls below its threshold, a single refinement pass produces V2. Any failure falls back to V1 — refinement never fails the request.

---

## 📈 Performance
Measured against the deployed Vercel app. Together AI's serverless throughput varies
run to run, so these are ranges rather than guarantees.

| Path | Latency |
| --- | --- |
| Clarifying questions returned | ~1.5s |
| Draft prompt visible | ~10–20s |
| Final prompt (after judge + optional refinement) | ~20–30s |
| Semantic cache hit | ~3s |

* **Context Grounding:** The research list shows only papers the model explicitly cites for
  the final prompt. Citation IDs are checked against supplied records, but model citations
  cannot prove which papers influenced internal reasoning. If none are cited, the UI says so.
* **Reasoning depth:** All model calls run at `reasoning_effort: "low"`. The synthesis prompt
  already asks for an explicit `<thinking>` section, so the default depth duplicated that work
  for ~4–6x the latency with no measured quality gain.

---

## 🛠️ Getting Started

### Prerequisites
* Node.js 20.6.0+
* Together AI API Key (reasoning model)
* OpenAI API Key (embeddings + LLM-as-a-judge evaluation)
* Supabase Project (with `pgvector` enabled — schema in `lib/supabase.js`)
* Upstash Redis (for semantic caching)

### Installation
1.  **Clone the Repo:**
    ```bash
    git clone https://github.com/SriramGanne/PromptPilot.git
    cd PromptPilot
    ```
2.  **Environment Setup:**
    Create a `.env.local` file:
    ```env
    TOGETHER_API_KEY=your_key
    OPENAI_API_KEY=your_key
    SUPABASE_URL=your_url
    SUPABASE_SERVICE_ROLE_KEY=your_key
    UPSTASH_REDIS_REST_URL=your_url
    UPSTASH_REDIS_REST_TOKEN=your_token
    ```
3.  **Connect the reviewed Vault:**
    Use the existing PromptPilot database with the lifecycle migrations in
    `db/migrations/`. Follow [Vault maintenance](docs/vault-maintenance.md) for
    reviewed updates. The current curation manifests target existing UUIDs;
    they are not an empty-database bootstrap. Legacy seed ingestion is disabled
    to prevent old citations and retired records from being restored.
4.  **Launch:**
    ```bash
    npm run dev
    ```

### Maintenance
* **Changing the embedding model.** `EMBEDDING_MODEL` and `EMBEDDING_DIM` live in
  `lib/models.mjs` and every embedding call goes through `lib/embeddings.mjs`. Vectors from
  different models are not comparable, so after changing either value, re-embed the vault in
  place and update the pgvector column if the dimension changed:
    ```bash
    node --env-file=.env.local scripts/reembed_research.mjs
    ```
  The cosine thresholds are calibrated per model — see the notes on `RAG_MATCH_THRESHOLD`
  (`app/api/orchestrate/route.js`), `SIMILARITY_THRESHOLD` (`lib/semanticCache.js`) and
  `DEFAULT_SIM_THRESHOLD` (`lib/researchCurator.mjs`) before swapping models.
* **Changing the reasoning model.** `REASONING_MODEL` in `lib/models.mjs` is the single source
  for gap analysis, synthesis, and refinement.
* **Testing:** `npm test` runs evaluation, curation, maintenance and hybrid-retrieval
  regressions. `npm run build` checks the production build. Read-only live retrieval
  probes and the safe curation workflow are documented in [Vault maintenance](docs/vault-maintenance.md).

---

## 🗺️ Roadmap
* **[ ] Multimodal Intent:** Support for image-to-prompt (Visual Prompt Engineering).
* **[ ] Team Workspaces:** Collaborative Knowledge Vaults for enterprise teams.
* **[ ] Live Eval Dashboard:** Public-facing metrics on prompt "Win Rates" using Sonnet 4.6 auditing.

## 📄 License
Distributed under the MIT License. See `LICENSE` for more information.

---
**Developed by Sriram Ganne** *Senior AI Product Management Portfolio Project*
