// ---------------------------------------------------------------------------
// PromptPilot — Knowledge Vault Research Curator (core)
//
// Reusable, side-effect-light engine that discovers, de-duplicates, scores, and
// (optionally) ingests prompt-engineering research into the `prompt_research`
// pgvector table. It REUSES the existing embedding pipeline (Together AI e5,
// 1024-dim, "passage:" prefix at ingest — see scripts/ingest_research.mjs) so
// retrieval stays consistent with what /api/orchestrate queries.
//
// DESIGN GOALS
//   • Curated, not bulk: every candidate passes a relevance gate + semantic
//     dedup before it can be ingested. We never ingest blindly.
//   • Safe by default: `runCuration` is DRY-RUN unless { ingest: true } is
//     passed. Ingestion is INSERT-ONLY — existing rows are never updated or
//     deleted, preserving Knowledge Vault integrity.
//   • Pluggable sources: a "source adapter" yields candidates. Two ship today —
//     `arxivSource` (programmatic, automatable) and `fileSource` (a vetted JSON
//     batch). New adapters (Anthropic/OpenAI/DeepMind blogs, HF papers) just
//     implement `collect()` and slot in.
//   • Automation-ready, not automated: `runCuration` is a pure-ish async fn a
//     CLI, a Next route handler, or a future cron job can call. Scheduling is
//     intentionally NOT implemented here (see FUTURE AUTOMATION at the bottom).
//
// This module performs NO scheduling and starts NO timers. Callers drive it.
// ---------------------------------------------------------------------------

// ── Embedding config — kept in sync with scripts/ingest_research.mjs ─────────
export const EMBEDDING_MODEL = "intfloat/multilingual-e5-large-instruct"; // 1024-dim
const PASSAGE_PREFIX = "passage: "; // e5 requires this for documents
const EMBED_DIM = 1024;

// ── Curation defaults ────────────────────────────────────────────────────────
// A candidate counts as a semantic DUPLICATE when its cosine similarity to any
// existing vault vector is >= this threshold.
//
// CALIBRATION (data-driven, not a guess): e5-large-instruct embeddings of a
// narrow, single-domain corpus (all entries are prompt-engineering text) cluster
// tightly. Measured over the 66 pairwise similarities among the 12 seed entries
// — all of which are KNOWN-DISTINCT techniques — the distribution was:
//   max 0.904 (Few-Shot ↔ Meta-Prompting), p95 0.894, p90 0.881, median 0.850.
// So distinct techniques routinely reach ~0.90 here. An absolute cutoff below
// that (e.g. 0.86) mislabels distinct papers as duplicates. We set the floor at
// 0.93 — clearly above the observed distinct-pair ceiling — so only a genuine
// restatement of an existing entry (which embeds ~0.95+) is skipped. The runtime
// semantic CACHE uses 0.90 for a different job (matching paraphrased queries),
// so the two thresholds are intentionally different.
export const DEFAULT_SIM_THRESHOLD = 0.93;

// A candidate must reach this composite relevance score (0–10) to be accepted.
export const DEFAULT_MIN_SCORE = 6;

// Topic lexicon used by the heuristic relevance scorer. Each bucket maps to one
// of the four metadata scores the spec asks for. Matching is substring-based
// over the candidate's title + abstract + distilled content (lower-cased).
const TOPIC_LEXICON = {
  // research_quality is judged structurally (citations/benchmarks/venue), not by
  // topic — see scoreCandidate(). These buckets drive the other three scores.
  practical_value: [
    "prompt", "instruction", "few-shot", "zero-shot", "in-context", "template",
    "structured output", "json", "format", "tool use", "function calling",
    "system prompt", "persona", "delimiter", "guardrail", "reliability",
  ],
  prompt_optimization_relevance: [
    "chain-of-thought", "chain of thought", "reasoning", "self-consistency",
    "self-refine", "self-critique", "reflection", "reflexion", "verification",
    "plan-and-solve", "step-back", "decomposition", "tree of thought",
    "prompt optimization", "optimizer", "automatic prompt", "self-improve",
    "agent", "planning", "react", "constitutional",
  ],
  evaluation_relevance: [
    "evaluation", "evaluator", "llm-as-a-judge", "llm as a judge", "g-eval",
    "ragas", "benchmark", "metric", "human alignment", "faithfulness",
    "hallucination", "rubric", "scoring", "judge",
  ],
};

// ---------------------------------------------------------------------------
// Math (pure)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// pgvector columns come back from PostgREST as a JSON-ish string "[0.1,0.2,…]"
// (or already an array depending on client). Normalise to a number[].
export function parseEmbedding(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Heuristic scoring (no LLM, no keys → safe for unattended automation)
// ---------------------------------------------------------------------------

function countLexHits(haystack, terms) {
  let hits = 0;
  for (const t of terms) if (haystack.includes(t)) hits++;
  return hits;
}

// Map a raw hit-count to a 1–10 score with diminishing returns.
function hitsToScore(hits) {
  if (hits <= 0) return 1;
  // 1→5, 2→6, 3→7, 4→8, 5→9, 6+→10  (clamped)
  return Math.min(10, 4 + hits);
}

/**
 * Score a candidate on the four spec dimensions (1–10) and decide acceptance.
 * If the candidate carries explicit `scores` (a vetted file batch authored by a
 * human curator), those are TRUSTED and used verbatim — heuristics only fill
 * gaps. This lets discovery (arXiv) be fully automatic while hand-curated
 * batches keep curator judgment.
 *
 * research_quality is inferred structurally: a real arXiv/DOI citation and the
 * presence of benchmark/measurement language raise it; otherwise it stays modest.
 */
export function scoreCandidate(candidate, { minScore = DEFAULT_MIN_SCORE } = {}) {
  const hay = [
    candidate.title ?? "",
    candidate.abstract ?? "",
    candidate.content ?? "",
    candidate.summary ?? "",
    candidate.best_for ?? "",
  ].join(" \n ").toLowerCase();

  const provided = candidate.scores ?? {};

  const practical_value =
    provided.practical_value ?? hitsToScore(countLexHits(hay, TOPIC_LEXICON.practical_value));
  const prompt_optimization_relevance =
    provided.prompt_optimization_relevance ??
    hitsToScore(countLexHits(hay, TOPIC_LEXICON.prompt_optimization_relevance));
  const evaluation_relevance =
    provided.evaluation_relevance ?? hitsToScore(countLexHits(hay, TOPIC_LEXICON.evaluation_relevance));

  let research_quality = provided.research_quality;
  if (research_quality == null) {
    const hasCitation = /arxiv\.org|doi\.org|\.pdf|docs\./i.test(candidate.url ?? "");
    const measured = /(\bgsm8k\b|\bmmlu\b|benchmark|outperform|accuracy|spearman|state-of-the-art|sota|%\s|improv)/i.test(hay);
    research_quality = Math.min(10, 4 + (hasCitation ? 2 : 0) + (measured ? 2 : 0));
  }

  // Composite gate: optimization relevance is the mission, so it's weighted
  // highest; the candidate must be EITHER strongly optimization-relevant OR
  // strongly evaluation-relevant (PromptPilot cares about both) to pass.
  const composite =
    0.4 * prompt_optimization_relevance +
    0.25 * evaluation_relevance +
    0.2 * practical_value +
    0.15 * research_quality;

  const topicalFloor =
    prompt_optimization_relevance >= 6 || evaluation_relevance >= 6 || practical_value >= 7;

  const scores = {
    research_quality: round1(research_quality),
    practical_value: round1(practical_value),
    prompt_optimization_relevance: round1(prompt_optimization_relevance),
    evaluation_relevance: round1(evaluation_relevance),
  };

  const accept = composite >= minScore && topicalFloor;
  const reasons = [];
  if (!topicalFloor) reasons.push("below topical floor (not clearly prompt/eval relevant)");
  if (composite < minScore) reasons.push(`composite ${round1(composite)} < min ${minScore}`);

  return { scores, composite: round1(composite), accept, reasons };
}

function round1(n) { return Math.round(n * 10) / 10; }

// ---------------------------------------------------------------------------
// Embedding (reuses the Together e5 pipeline, with retry/backoff)
// ---------------------------------------------------------------------------

export async function embedDocument(together, text) {
  const input = `${PASSAGE_PREFIX}${text}`;
  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await together.embeddings.create({ model: EMBEDDING_MODEL, input });
      const vec = res.data[0].embedding;
      if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
        throw new Error(`Expected ${EMBED_DIM}-dim embedding, got ${vec?.length}`);
      }
      return vec;
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Vault access (read existing for dedup; insert-only for ingest)
// ---------------------------------------------------------------------------

// Pull existing rows (title + embedding) for semantic dedup. Also returns the
// set of optional metadata columns the live table actually has, so ingestion
// can populate richer columns when present and silently skip them otherwise
// (keeps the curator runnable without a migration).
export async function loadVaultIndex(supabase) {
  const { data, error } = await supabase
    .from("prompt_research")
    .select("title, embedding");
  if (error) throw new Error(`Failed to read vault: ${error.message}`);

  const rows = (data ?? [])
    .map((r) => ({ title: r.title, embedding: parseEmbedding(r.embedding) }))
    .filter((r) => Array.isArray(r.embedding) && r.embedding.length === EMBED_DIM);

  return {
    titles: new Set((data ?? []).map((r) => r.title)),
    vectors: rows,
    optionalColumns: await detectOptionalColumns(supabase),
  };
}

// Probe which optional metadata columns exist (best-effort). A failed probe just
// means "treat as absent" — we never let introspection break a run.
const OPTIONAL_COLUMNS = [
  "authors", "publication_date",
  "research_quality", "practical_value",
  "prompt_optimization_relevance", "evaluation_relevance",
];
async function detectOptionalColumns(supabase) {
  const present = new Set();
  for (const col of OPTIONAL_COLUMNS) {
    const { error } = await supabase.from("prompt_research").select(col).limit(1);
    if (!error) present.add(col);
  }
  return present;
}

/**
 * Build the DB row for an accepted candidate. Required columns always present;
 * optional metadata columns included ONLY if the live table has them.
 */
export function buildRow(candidate, embedding, scores, optionalColumns, sourceTag) {
  const row = {
    title: candidate.title,
    content: candidate.content ?? candidate.abstract ?? "",
    summary: candidate.summary ?? null,
    best_for: candidate.best_for ?? null,
    category: candidate.category ?? null,
    citation_url: candidate.url ?? candidate.citation_url ?? null,
    is_featured: Boolean(candidate.is_featured),
    source_file: sourceTag,
    embedding,
  };
  const add = (col, val) => { if (optionalColumns.has(col) && val != null) row[col] = val; };
  add("authors", Array.isArray(candidate.authors) ? candidate.authors.join(", ") : candidate.authors);
  add("publication_date", candidate.publishedDate ?? candidate.publication_date);
  add("research_quality", scores.research_quality);
  add("practical_value", scores.practical_value);
  add("prompt_optimization_relevance", scores.prompt_optimization_relevance);
  add("evaluation_relevance", scores.evaluation_relevance);
  return row;
}

// ---------------------------------------------------------------------------
// Source adapters
// ---------------------------------------------------------------------------

/**
 * arXiv adapter — programmatic discovery via the public Atom API (no key).
 * Automatable: a future cron job calls this with { since } to pull only
 * papers newer than the vault's latest knowledge.
 *
 * NOTE: kept minimal and dependency-free (regex Atom parse). It returns RAW
 * candidates (title/abstract/authors/date/url); distillation into a polished
 * vault entry is a separate, human-or-LLM step — we never auto-write an
 * abstract as if it were a curated entry.
 */
export const arxivSource = {
  name: "arxiv",
  async collect({ categories = ["cs.CL", "cs.AI"], maxResults = 25, since = null, query = null, fetchImpl = fetch } = {}) {
    const cat = categories.map((c) => `cat:${c}`).join("+OR+");
    const search = query ? `all:${encodeURIComponent(query)}` : cat;
    const url =
      `http://export.arxiv.org/api/query?search_query=${search}` +
      `&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;

    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`arXiv API ${res.status}`);
    const xml = await res.text();

    const entries = [];
    for (const block of xml.split(/<entry>/).slice(1)) {
      const pick = (tag) => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "").trim();
      const id = pick("id");
      const published = pick("published").slice(0, 10);
      if (since && published && published < since) continue;
      const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((m) => m[1].trim());
      entries.push({
        title: pick("title").replace(/\s+/g, " "),
        abstract: pick("summary").replace(/\s+/g, " "),
        authors,
        publishedDate: published || null,
        url: id.replace("http://", "https://"),
      });
    }
    return entries;
  },
};

/**
 * File adapter — load a vetted JSON batch of curated candidates. Same shape as
 * data/seed_research.json, optionally carrying `authors`, `publishedDate`, and
 * an explicit `scores` object (curator judgment, trusted by scoreCandidate).
 */
export const fileSource = {
  name: "file",
  async collect({ entries }) {
    if (!Array.isArray(entries)) throw new Error("fileSource needs { entries: [...] }");
    return entries;
  },
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run one curation pass: collect → dedup (title + semantic) → score/gate →
 * (optionally) embed + insert → report. NEVER throws for per-candidate issues;
 * a single bad candidate is recorded as an error and the pass continues.
 *
 * @param {object}   opts
 * @param {object}   opts.supabase                - Supabase client (service role)
 * @param {object}   opts.together                - OpenAI-compatible client → Together (for embeddings)
 * @param {object}   opts.candidates              - pre-collected candidate array (from a source adapter)
 * @param {boolean} [opts.ingest=false]           - false = DRY RUN (no writes)
 * @param {number}  [opts.simThreshold=0.86]      - semantic-dedup cosine cutoff
 * @param {number}  [opts.minScore=6]             - acceptance composite floor
 * @param {string}  [opts.sourceTag="curator"]    - written to source_file
 * @param {function}[opts.log=console.log]
 * @returns {Promise<Report>}
 */
export async function runCuration({
  supabase,
  together,
  candidates,
  ingest = false,
  simThreshold = DEFAULT_SIM_THRESHOLD,
  minScore = DEFAULT_MIN_SCORE,
  sourceTag = "curator",
  log = () => {},
}) {
  if (!Array.isArray(candidates)) throw new Error("runCuration needs a candidates array");

  const report = {
    mode: ingest ? "ingest" : "dry-run",
    found: candidates.length,
    accepted: [],
    rejected: [],
    duplicates: [],
    ingested: [],
    errors: [],
  };

  log(`Loading vault index for dedup…`);
  const vault = await loadVaultIndex(supabase);
  log(`  ${vault.vectors.length} existing vectors; optional columns present: ${[...vault.optionalColumns].join(", ") || "none"}`);

  for (const cand of candidates) {
    try {
      if (!cand?.title || !(cand.content || cand.abstract)) {
        report.errors.push({ title: cand?.title ?? "(untitled)", reason: "missing title/content" });
        continue;
      }

      // 1) Exact-title dedup (cheap).
      if (vault.titles.has(cand.title)) {
        report.duplicates.push({ title: cand.title, kind: "exact-title", nearest: cand.title, similarity: 1 });
        continue;
      }

      // 2) Relevance gate (no embedding cost for rejects).
      const scored = scoreCandidate(cand, { minScore });
      if (!scored.accept) {
        report.rejected.push({ title: cand.title, scores: scored.scores, composite: scored.composite, reasons: scored.reasons });
        continue;
      }

      // 3) Semantic dedup — embed once, compare against all existing vectors.
      const embedding = await embedDocument(together, cand.content ?? cand.abstract);
      let nearest = { title: null, similarity: 0 };
      for (const v of vault.vectors) {
        const sim = cosineSimilarity(embedding, v.embedding);
        if (sim > nearest.similarity) nearest = { title: v.title, similarity: sim };
      }
      if (nearest.similarity >= simThreshold) {
        report.duplicates.push({ title: cand.title, kind: "semantic", nearest: nearest.title, similarity: round1(nearest.similarity * 100) / 100 });
        continue;
      }

      const accepted = {
        title: cand.title,
        category: cand.category ?? null,
        url: cand.url ?? cand.citation_url ?? null,
        scores: scored.scores,
        composite: scored.composite,
        nearestExisting: { title: nearest.title, similarity: round1(nearest.similarity * 100) / 100 },
      };
      report.accepted.push(accepted);

      // 4) Ingest (insert-only) — guarded by the ingest flag.
      if (ingest) {
        const row = buildRow(cand, embedding, scored.scores, vault.optionalColumns, sourceTag);
        const { error } = await supabase.from("prompt_research").insert(row);
        if (error) {
          report.errors.push({ title: cand.title, reason: `insert failed: ${error.message}` });
        } else {
          report.ingested.push(cand.title);
          // Keep the in-memory index fresh so later candidates dedup against
          // freshly-inserted ones too (prevents intra-batch near-duplicates).
          vault.titles.add(cand.title);
          vault.vectors.push({ title: cand.title, embedding });
        }
      }
    } catch (err) {
      report.errors.push({ title: cand?.title ?? "(untitled)", reason: err.message });
    }
  }

  return report;
}

/**
 * Render the spec-mandated report as a human-readable string.
 */
export function formatReport(report) {
  const L = [];
  L.push(`# PromptPilot Knowledge Vault — Curation Report (${report.mode})`);
  L.push("");
  L.push(`New sources found:  ${report.found}`);
  L.push(`Accepted:           ${report.accepted.length}`);
  L.push(`Rejected:           ${report.rejected.length}`);
  L.push(`Duplicates skipped: ${report.duplicates.length}`);
  L.push(`${report.mode === "ingest" ? "Added to vault" : "Would add"}:      ${report.mode === "ingest" ? report.ingested.length : report.accepted.length}`);
  if (report.errors.length) L.push(`Errors:             ${report.errors.length}`);
  L.push("");

  if (report.accepted.length) {
    L.push(`## Accepted${report.mode === "ingest" ? " & ingested" : " (dry run — not written)"}`);
    for (const a of report.accepted) {
      const s = a.scores;
      L.push(`- ${a.title}  [${a.category ?? "-"}]`);
      L.push(`    ${a.url ?? ""}`);
      L.push(`    scores → research:${s.research_quality} practical:${s.practical_value} optimization:${s.prompt_optimization_relevance} evaluation:${s.evaluation_relevance} (composite ${a.composite})`);
      L.push(`    nearest existing: ${a.nearestExisting.title ?? "—"} @ ${a.nearestExisting.similarity}`);
    }
    L.push("");
  }
  if (report.duplicates.length) {
    L.push(`## Duplicates skipped`);
    for (const d of report.duplicates) L.push(`- ${d.title}  (${d.kind} ≈ "${d.nearest}" @ ${d.similarity})`);
    L.push("");
  }
  if (report.rejected.length) {
    L.push(`## Rejected`);
    for (const r of report.rejected) L.push(`- ${r.title}  (${r.reasons.join("; ")})`);
    L.push("");
  }
  if (report.errors.length) {
    L.push(`## Errors`);
    for (const e of report.errors) L.push(`- ${e.title}: ${e.reason}`);
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// FUTURE AUTOMATION (intentionally NOT wired up here)
// ---------------------------------------------------------------------------
//
// `runCuration` is the single entry point a scheduler would call. To automate
// later, add ONE of these without touching this file:
//
//   • Cron / GitHub Action (recommended for unattended runs):
//       node --env-file=.env.local scripts/curate_research.mjs \
//         --source=arxiv --since=<vault-latest-date> --min-score=7
//     Run nightly/weekly; pipe the report to logs or Slack. Keep DRY-RUN in CI
//     and require a human to re-run with --ingest, OR gate --ingest behind a
//     high min-score so only strong, non-duplicate papers are written.
//
//   • Next.js route (manual trigger from an admin UI):
//       export async function POST() { const r = await runCuration({...}); ... }
//     Protect it behind auth; default ingest:false and require an explicit flag.
//
//   • Vercel Cron → the route above, on a schedule.
//
// None of the above is implemented now — only the architecture (this module +
// the CLI) is in place so any of them is a thin wrapper later.
