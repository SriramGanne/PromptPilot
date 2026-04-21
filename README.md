# PromptPilot 🚀
**Bridging the Gap Between Raw Intent and Production-Ready Prompts.**

PromptPilot is an advanced, research-grounded Prompt Engineering Agent designed for non-technical professionals. It eliminates the "trial-and-error" loop of working with LLMs by using an agentic reasoning workflow to transform vague thoughts into structured, high-performance instructions.

---

## 🎯 The Problem
Most professional users struggle with **Instruction Drift** and **Prompt Ambiguity**. While frontier models are powerful, they require specific structural markers (XML, CoT, Delimiters) to perform consistently. PromptPilot acts as the "Navigator," translating simple language into the technical "handshake" LLMs require.

## ✨ Key Product Features
* **Agentic Interviewer:** Uses a "Gap Analysis" logic to identify missing variables (Context, Persona, Format) and asks targeted follow-up questions before generating.
* **Knowledge Vault (RAG):** A curated library of 2026 prompt engineering research. Every prompt is grounded in techniques like *Chain-of-Thought*, *Chain-of-Density*, and *Self-Consistency*.
* **Asymmetric Reasoning:** Powered by **Gemma 3n E4B**, utilizing Matryoshka embeddings and Per-Layer Embedding (PLE) caching for high-density logic with sub-400ms latency.
* **Power Mode:** Provides a transparent "Reasoning Trace" (`<thinking>` tags), showing the user exactly how the AI interpreted their request.
* **Model-Aware Optimization:** Tailors output structure specifically for the target model (Claude, GPT-4, Gemini, or Grok).

---

## 🏗️ Technical Architecture


### The Intelligence Stack
* **Core Logic:** `google/gemma-3n-e4b-it` (optimized for latency-to-logic efficiency).
* **Vector Database:** `Supabase (pgvector)` storing 1024-dimension embeddings.
* **Embedding Model:** `intfloat/multilingual-e5-large-instruct` (utilizing `passage:`/`query:` instruction prefixes).
* **Semantic Cache:** `Upstash Redis` to reduce COGS and latency for redundant high-intent queries.

### Evaluator-Optimizer Design Pattern
PromptPilot doesn't just "guess." It follows a closed-loop system:
1.  **Ingestion:** RAG retrieval of best practices.
2.  **Synthesis:** Gemma 3 generates the "Improved Prompt."
3.  **Audit:** Internal regression testing against a G-Eval rubric (Faithfulness, Specificity, Structure).

---

## 📈 Performance & Unit Economics
* **Latency:** Average Time to First Token (TTFT) < 350ms via Together AI Serverless.
* **Context Grounding:** 100% of generated prompts include citations from the Knowledge Vault.
* **Optimization Alpha:** Average 25-35% reduction in "Prompt Drift" compared to raw user inputs.

---

## 🛠️ Getting Started

### Prerequisites
* Node.js 20.6.0+
* Together AI API Key
* Supabase Project (with `pgvector` enabled)
* Upstash Redis (for semantic caching)

### Installation
1.  **Clone the Repo:**
    ```bash
    git clone https://github.com/SriramGanne/promptpilot.git
    cd promptpilot
    ```
2.  **Environment Setup:**
    Create a `.env.local` file:
    ```env
    TOGETHER_API_KEY=your_key
    NEXT_PUBLIC_SUPABASE_URL=your_url
    NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key
    UPSTASH_REDIS_REST_URL=your_url
    UPSTASH_REDIS_REST_TOKEN=your_token
    ```
3.  **Seed the Vault:**
    ```bash
    node --env-file=.env.local scripts/ingest_research.mjs
    ```
4.  **Launch:**
    ```bash
    npm run dev
    ```

---

## 🗺️ Roadmap
* **[ ] Multimodal Intent:** Support for image-to-prompt (Visual Prompt Engineering).
* **[ ] Team Workspaces:** Collaborative Knowledge Vaults for enterprise teams.
* **[ ] Live Eval Dashboard:** Public-facing metrics on prompt "Win Rates" using Sonnet 4.6 auditing.

## 📄 License
Distributed under the MIT License. See `LICENSE` for more information.

---
**Developed by Sriram Ganne** *Senior AI Product Management Portfolio Project*
