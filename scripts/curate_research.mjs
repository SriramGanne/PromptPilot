/**
 * scripts/curate_research.mjs
 *
 * CLI for the Knowledge Vault Research Curator (lib/researchCurator.mjs).
 * DRY-RUN by default — it will NOT write to the DB unless you pass --ingest.
 *
 * Examples:
 *   # Dry-run a vetted curated batch (default source/path):
 *   node --env-file=.env.local scripts/curate_research.mjs
 *
 *   # Actually ingest that batch:
 *   node --env-file=.env.local scripts/curate_research.mjs --ingest
 *
 *   # Discover recent arXiv papers newer than the vault (dry-run):
 *   node --env-file=.env.local scripts/curate_research.mjs \
 *     --source=arxiv --since=2024-01-01 --max=30 --min-score=7
 *
 * Flags:
 *   --source=file|arxiv     (default: file)
 *   --path=<json>           (file source; default: data/curated_candidates.json)
 *   --since=YYYY-MM-DD      (arxiv source; only papers on/after this date)
 *   --categories=cs.CL,cs.AI (arxiv source)
 *   --query="..."          (arxiv source; free-text instead of categories)
 *   --max=N                 (arxiv source; default 25)
 *   --min-score=N           (acceptance composite floor; default 6)
 *   --sim=0.86              (semantic-dedup cosine threshold)
 *   --ingest                (perform inserts; omit for dry-run)
 *
 * Required env (.env.local): TOGETHER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import {
  runCuration,
  formatReport,
  arxivSource,
  fileSource,
  DEFAULT_SIM_THRESHOLD,
  DEFAULT_MIN_SCORE,
} from "../lib/researchCurator.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
    else args._.push(a);
  }
  return args;
}

function buildClients() {
  const missing = ["TOGETHER_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    console.error("Run with: node --env-file=.env.local scripts/curate_research.mjs ...");
    process.exit(1);
  }
  const together = new OpenAI({
    apiKey: process.env.TOGETHER_API_KEY,
    baseURL: "https://api.together.xyz/v1",
  });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return { together, supabase };
}

async function collectCandidates(args) {
  const source = args.source ?? "file";
  if (source === "file") {
    const path = resolve(args.path ?? "data/curated_candidates.json");
    const entries = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(entries)) throw new Error(`Expected a JSON array in ${path}`);
    console.log(`Source: file (${path}) → ${entries.length} candidates`);
    return { candidates: await fileSource.collect({ entries }), sourceTag: path.split("/").pop() };
  }
  if (source === "arxiv") {
    const categories = (args.categories ?? "cs.CL,cs.AI").split(",").map((s) => s.trim());
    const candidates = await arxivSource.collect({
      categories,
      query: args.query ?? null,
      since: args.since ?? null,
      maxResults: args.max ? Number(args.max) : 25,
    });
    console.log(`Source: arxiv (${args.query ? `query="${args.query}"` : categories.join(",")}${args.since ? `, since=${args.since}` : ""}) → ${candidates.length} candidates`);
    return { candidates, sourceTag: "arxiv" };
  }
  throw new Error(`Unknown --source=${source} (use file|arxiv)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ingest = Boolean(args.ingest);
  const minScore = args["min-score"] ? Number(args["min-score"]) : DEFAULT_MIN_SCORE;
  const simThreshold = args.sim ? Number(args.sim) : DEFAULT_SIM_THRESHOLD;

  const { together, supabase } = buildClients();
  const { candidates, sourceTag } = await collectCandidates(args);

  console.log(`Mode: ${ingest ? "INGEST (will write)" : "DRY-RUN (no writes)"} | minScore=${minScore} | simThreshold=${simThreshold}\n`);

  const report = await runCuration({
    supabase,
    together,
    candidates,
    ingest,
    minScore,
    simThreshold,
    sourceTag,
    log: console.log,
  });

  console.log("\n" + formatReport(report));

  if (!ingest && report.accepted.length) {
    console.log(`\nThis was a DRY RUN. Re-run with --ingest to write the ${report.accepted.length} accepted entr${report.accepted.length === 1 ? "y" : "ies"}.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
