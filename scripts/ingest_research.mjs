/**
 * scripts/ingest_research.mjs
 *
 * Seeds the `prompt_research` table from data/seed_research.json.
 *
 * - Reads a JSON array of entries with the shape:
 *     { title, content, summary, category, citation_url, is_featured }
 * - Skips entries whose `title` already exists in Supabase (dedup).
 * - Generates a 1024-dim embedding of each new entry's `content` using
 *   Together AI's BAAI/bge-large-en-v1.5 retrieval model.
 * - Inserts the remaining rows with all Knowledge Vault fields populated.
 *
 * Usage:
 *   node --env-file=.env.local scripts/ingest_research.mjs [path-to-json]
 *
 * Path is optional; defaults to data/seed_research.json.
 *
 * Required env vars (in .env.local):
 *   TOGETHER_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { embedText } from "../lib/embeddings.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_SEED_PATH = "data/seed_research.json";
const INSERT_BATCH_SIZE = 10;                        // rows per DB insert
const EMBED_DELAY_MS    = 200;                       // courtesy delay between API calls

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function buildClients() {
  const missing = [
    "OPENAI_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].filter((k) => !process.env[k]);

  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    console.error("Run: node --env-file=.env.local scripts/ingest_research.mjs [path]");
    process.exit(1);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  return { supabase };
}

// ---------------------------------------------------------------------------
// Seed JSON loader + validator
// ---------------------------------------------------------------------------

/**
 * Read the seed file and return the subset of entries that have both a
 * title and a content field. Malformed entries are warned about and skipped.
 */
function readSeedJson(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    console.error(`Cannot read file: ${filePath}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON in ${filePath}: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error(`Expected a JSON array at the top level; got ${typeof parsed}`);
    process.exit(1);
  }

  const valid = [];
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e?.title || !e?.content) {
      console.warn(`  ⚠ Entry ${i} missing title or content — skipping`);
      continue;
    }
    valid.push(e);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Dedup: fetch existing titles from Supabase
// ---------------------------------------------------------------------------

/**
 * Returns a Set of every title currently in prompt_research.
 * Used to pre-filter the seed list so we don't re-embed or re-insert duplicates.
 */
async function fetchExistingTitles(supabase) {
  const { data, error } = await supabase
    .from("prompt_research")
    .select("title");
  if (error) throw new Error(`Failed to fetch existing titles: ${error.message}`);
  return new Set((data ?? []).map((r) => r.title));
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/**
 * Embed a single document string via the shared lib/embeddings.mjs path.
 * Retries on transient 5xx / network errors with exponential backoff.
 */
async function embed(text) {
  const MAX_RETRIES = 4;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await embedText(text);
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const retryable = !status || status === 503 || status === 502 || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw err;
      const backoff = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s
      console.log(`    ⚠ ${status ?? "network"} error — retrying in ${backoff}ms (attempt ${attempt}/${MAX_RETRIES - 1})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// ---------------------------------------------------------------------------
// Insert (batched)
// ---------------------------------------------------------------------------

async function insertBatch(supabase, rows) {
  const { error } = await supabase.from("prompt_research").insert(rows);
  if (error) throw new Error(`Insert failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const filePath = resolve(process.argv[2] ?? DEFAULT_SEED_PATH);
  const { supabase } = buildClients();

  console.log(`Reading ${filePath}…`);
  const entries = readSeedJson(filePath);
  console.log(`  ${entries.length} valid entries loaded.\n`);

  console.log("Checking existing titles in prompt_research…");
  const existingTitles = await fetchExistingTitles(supabase);
  console.log(`  ${existingTitles.size} rows already in the table.`);

  // Dedup by title — skip embedding for anything already present, but still
  // sync editable metadata (summary, best_for, category, citation_url,
  // is_featured) so edits to the seed JSON land in the DB on re-run.
  const fresh     = entries.filter((e) => !existingTitles.has(e.title));
  const existing  = entries.filter((e) =>  existingTitles.has(e.title));
  const skipped   = existing.length;
  if (skipped > 0) {
    console.log(`  ↪ ${skipped} duplicate${skipped === 1 ? "" : "s"} — will sync metadata (no re-embed).`);
  }

  // ── Metadata sync for existing rows ────────────────────────────────────
  if (existing.length > 0) {
    console.log(`\nSyncing metadata for ${existing.length} existing row${existing.length === 1 ? "" : "s"}…`);
    for (const e of existing) {
      const { error } = await supabase
        .from("prompt_research")
        .update({
          summary:      e.summary ?? null,
          best_for:     e.best_for ?? null,
          category:     e.category ?? null,
          citation_url: e.citation_url ?? null,
          is_featured:  Boolean(e.is_featured),
        })
        .eq("title", e.title);
      if (error) {
        console.warn(`  ⚠ Failed to sync "${e.title}": ${error.message}`);
      } else {
        console.log(`  ✓ Synced: "${e.title}"`);
      }
    }
  }

  if (fresh.length === 0) {
    console.log("\nNo new entries to embed. Done.");
    return;
  }

  // ── Embed new entries ──────────────────────────────────────────────────
  const sourceFile = filePath.split("/").pop();
  const rows = [];

  console.log(`\nGenerating embeddings for ${fresh.length} new entr${fresh.length === 1 ? "y" : "ies"}…`);
  for (let i = 0; i < fresh.length; i++) {
    const e = fresh[i];
    console.log(`  [${i + 1}/${fresh.length}] Embedding: "${e.title}"`);

    const embedding = await embed(e.content);
    rows.push({
      title:        e.title,
      content:      e.content,
      summary:      e.summary ?? null,
      best_for:     e.best_for ?? null,
      category:     e.category ?? null,
      citation_url: e.citation_url ?? null,
      is_featured:  Boolean(e.is_featured),
      source_file:  sourceFile,
      embedding,
    });

    console.log(`    ✓ ${embedding.length}-dim vector generated`);
    if (i < fresh.length - 1) await new Promise((r) => setTimeout(r, EMBED_DELAY_MS));
  }

  // ── Insert ─────────────────────────────────────────────────────────────
  console.log(`\nInserting ${rows.length} row${rows.length === 1 ? "" : "s"}…`);
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    await insertBatch(supabase, batch);
    console.log(`  Inserted rows ${i + 1}–${Math.min(i + INSERT_BATCH_SIZE, rows.length)}`);
  }

  console.log(`\nDone. Added ${rows.length}, skipped ${skipped}.`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
