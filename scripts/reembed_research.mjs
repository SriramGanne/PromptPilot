/**
 * Re-embed every row in prompt_research with the current EMBEDDING_MODEL.
 *
 * Run this whenever lib/models.mjs changes the embedding model or dimension:
 * vectors from different models are not comparable, so every stored vector
 * must be regenerated before retrieval works again. Updates in place — no
 * rows are inserted or deleted, so curated entries survive.
 *
 *   node --env-file=.env.local scripts/reembed_research.mjs [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import { embedText } from "../lib/embeddings.mjs";
import { EMBEDDING_MODEL, EMBEDDING_DIM } from "../lib/models.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const DELAY_MS = 100;

const missing = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
  (k) => !process.env[k]
);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: rows, error } = await supabase.from("prompt_research").select("id, title, content");
if (error) {
  console.error("Failed to read prompt_research:", error.message);
  process.exit(1);
}

console.log(`Re-embedding ${rows.length} rows with ${EMBEDDING_MODEL} @ ${EMBEDDING_DIM} dims${DRY_RUN ? " (DRY RUN)" : ""}\n`);

let ok = 0;
for (const [i, row] of rows.entries()) {
  process.stdout.write(`  [${i + 1}/${rows.length}] ${row.title} … `);
  try {
    const embedding = await embedText(row.content);
    if (!DRY_RUN) {
      const { error: upErr } = await supabase
        .from("prompt_research")
        .update({ embedding })
        .eq("id", row.id);
      if (upErr) throw new Error(upErr.message);
    }
    ok++;
    console.log("ok");
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

console.log(`\nDone: ${ok}/${rows.length} rows ${DRY_RUN ? "would be" : ""} updated.`);
process.exit(ok === rows.length ? 0 : 1);
