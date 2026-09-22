#!/usr/bin/env node
// Read-only retrieval checks. LIVE by default; --plan=<file> explicitly opts
// into simulation. --hyde exercises the production rewrite + retrieval path.
// --repeat=3 --only=2,3 repeats fragile probes without invoking orchestrate or
// writing prompt_metrics. Query embeddings/optional HyDE incur provider calls.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { embedText } from "../lib/embeddings.mjs";
import { rankHybridResearch } from "../lib/vaultRetrieval.mjs";
import { retrieveHybridResearch } from "../lib/vaultSearch.mjs";
import { REASONING_MODEL } from "../lib/models.mjs";
import { vocabularyFromRows, buildRetrievalQuerySystem } from "../lib/vaultTaxonomy.mjs";

const opt = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const USE_HYDE = process.argv.includes("--hyde");
const REPEATS = Number(opt("repeat") ?? 1);
if (!Number.isInteger(REPEATS) || REPEATS < 1 || REPEATS > 10) throw new Error("--repeat must be 1..10");
const ONLY = opt("only")?.split(",").map(Number);
const PROBES = [
  { q: "Optimize a prompt using textual feedback.", expect: ["TextGrad", "GEPA", "Self-Refine"] },
  { q: "Prevent an automatic prompt optimizer from drifting away from the task.", expect: ["Stabilizing Black-Box", "TRAS"] },
  { q: "Attribute failures to prompt segments and use several judges.", expect: ["Gradient-Guided Multi-Judge", "GMPO"] },
  { q: "Optimize prompt quality, model choice, cost and latency together.", expect: ["CORAL"] },
  { q: "Use tools during inference.", expect: ["ReAct"], forbid: ["Toolformer"] },
  { q: "Give the model a generic senior developer persona for more factual answers.", expect: ["Expert / Persona Prompting"] },
  { q: "Ground an answer in retrieved documents with citations and abstention.", expect: ["Retrieval-Augmented Generation"] },
  { q: "Use emotional wording to improve high-stakes factual accuracy.", expect: [], forbid: ["Emotional Stimuli", "EmotionPrompt"] },
  { q: "Optimize instructions and examples across a multi-stage language-model program.", expect: ["Multi-Stage Language Model Programs", "MIPRO"] },
  { q: "Use prompt structure as a searchable program.", expect: ["Symbolic Prompt Program Search", "SAMMO"] },
];
if (ONLY?.some((n) => !Number.isInteger(n) || n < 1 || n > PROBES.length)) throw new Error("Invalid --only probe numbers");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const liveRows = [];
for (let offset = 0; ; offset += 500) {
  const { data, error } = await sb.from("prompt_research").select("*").order("id").range(offset, offset + 499);
  if (error) throw new Error(error.message);
  liveRows.push(...data.map((r) => ({ ...r, embedding: typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding })));
  if (data.length < 500) break;
}
const planPath = opt("plan");
let corpus = liveRows;
if (planPath) {
  const saved = JSON.parse(readFileSync(planPath, "utf8"));
  const byId = new Map(liveRows.map((r) => [r.id, r]));
  for (const [index, action] of saved.plan.actions.entries()) {
    const id = action.op === "update" ? action.id : `planned-${index}`;
    if (action.op === "update" && !byId.has(id)) throw new Error(`Missing simulated update target: ${id}`);
    byId.set(id, { ...byId.get(id), ...action.set, id,
      embedding: action.embedding ?? byId.get(id)?.embedding });
  }
  corpus = [...byId.values()];
}
const active = corpus.filter((r) => r.status === "active" && r.retrieval_enabled === true);
const vocabulary = vocabularyFromRows(active);
const together = USE_HYDE ? new OpenAI({ apiKey: process.env.TOGETHER_API_KEY, baseURL: "https://api.together.xyz/v1" }) : null;
async function queryEmbedding(intent) {
  if (USE_HYDE) {
    try {
      const response = await together.chat.completions.create({
        model: REASONING_MODEL,
        messages: [{ role: "system", content: buildRetrievalQuerySystem(vocabulary) }, { role: "user", content: intent }],
        temperature: 0.2, max_tokens: 2000, reasoning_effort: "low",
      }, { timeout: 30000, maxRetries: 1 });
      const passage = response.choices?.[0]?.message?.content?.trim();
      if (!passage) throw new Error("empty HyDE passage");
      console.log(`  rewrite: ${passage.replace(/\s+/g, " ")}`);
      return { vector: await embedText(passage), fallback: false };
    } catch (err) {
      console.warn(`  HyDE unavailable; raw-intent fallback: ${err.message}`);
    }
  }
  return { vector: await embedText(intent), fallback: USE_HYDE };
}
function cosine(a, b) {
  if (!Array.isArray(b) || a.length !== b.length) throw new Error("Invalid corpus embedding");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
console.log(`MODE: ${planPath ? "SIMULATED PLAN" : "LIVE VAULT RPC"} | ${USE_HYDE ? "HyDE" : "direct query"} + original-intent lexical fusion`);
console.log(`corpus=${corpus.length} active=${active.length} excluded=${corpus.length - active.length} repeats=${REPEATS}`);
let passed = 0, failed = 0, fallbacks = 0;
for (let trial = 1; trial <= REPEATS; trial++) {
  for (const [index, probe] of PROBES.entries()) {
    if (ONLY && !ONLY.includes(index + 1)) continue;
    console.log(`\nTrial ${trial}, probe ${index + 1}: ${probe.q}`);
    const { vector, fallback } = await queryEmbedding(probe.q);
    if (fallback) fallbacks++;
    const raw = active.map((r) => ({ ...r, similarity: cosine(vector, r.embedding) })).sort((a, b) => b.similarity - a.similarity);
    const top = planPath
      ? rankHybridResearch(raw, { query: probe.q, limit: 3, matchThreshold: 0.25 })
      : await retrieveHybridResearch(sb, vector, { query: probe.q, limit: 3, matchThreshold: 0.25 });
    const names = top.map((r) => r.title.toLowerCase());
    const hit = !probe.expect.length || probe.expect.some((e) => names.some((n) => n.includes(e.toLowerCase())));
    const forbidden = (probe.forbid ?? []).filter((e) => names.some((n) => n.includes(e.toLowerCase())));
    const lifecycleOk = top.every((r) => r.status === "active" && r.retrieval_enabled === true);
    const ok = hit && !forbidden.length && lifecycleOk;
    if (ok) passed++; else failed++;
    console.log(ok ? "PASS" : "FAIL");
    for (const r of top) console.log(`  hybrid=${r.hybridScore.toFixed(3)} cosine=${r.similarity.toFixed(3)} raw-rank=${raw.findIndex((x) => x.id === r.id) + 1} ${r.title}`);
    if (!hit) console.log(`  Expected: ${probe.expect.join(" | ")}`);
    if (forbidden.length) console.log(`  Forbidden: ${forbidden.join(", ")}`);
  }
}
console.log(`\nprobes: ${passed} passed, ${failed} failed; HyDE fallbacks: ${fallbacks}`);
process.exitCode = failed ? 1 : 0;
