# PromptPilot vault maintenance

## Scope and source of truth

`data/vault/active_existing.json`, `active_additions.json` and `reference_only.json`
are the approved September 2026 curation manifests. Existing records are bound
to exact live UUIDs; do not guess replacement IDs on another database. Watchlist
and industry references are editorial files only, not retrieval inserts.

The planned reconciliation is 22 existing rows plus 18 additions = 40 physical
rows: 35 active/retrievable, two archived, one merged and two reference-only.
Toolformer and EmotionPrompt are retained as archived provenance. Constitutional
AI is merged into Self-Refine with an explicit destination pointer. Retirement
does not delete research history. `prompt_metrics` is outside this workflow.

## Database installation

The base `prompt_research` table and pgvector extension must already exist.
Install `db/migrations/0001_vault_lifecycle.sql` and then
`db/migrations/0002_apply_vault_migration.sql` in the Supabase SQL editor.
`RUN_IN_SUPABASE.sql` is a convenience bundle of both. If lifecycle columns are
already installed, rerun **0002 only** to update the atomic maintenance function.
It locks research writes during validation/application, checks embedding and
lifecycle constraints, and permits execution only by `service_role`.

Do not expose service-role credentials in browser code. `match_prompt_research`
must filter `status = 'active' AND retrieval_enabled`; the UI and lexical corpus
apply the same restriction. A versioned semantic-cache namespace prevents old
cached generations from returning the retired source set after deployment.

## Reviewed application

Run from the repository with `.env.local` configured. Backups default to
`~/.promptpilot-vault-backups`, outside Git, with directory mode 0700 and file
mode 0600. `--backup-dir=/absolute/secure/directory` overrides this location.
Retain snapshots, plans and receipts together. Never commit full database
snapshots, raw vectors or credentials.

```sh
node --env-file=.env.local scripts/vault_maintenance.mjs status
node --env-file=.env.local scripts/vault_maintenance.mjs backup
node --env-file=.env.local scripts/vault_maintenance.mjs plan
node --env-file=.env.local scripts/vault_maintenance.mjs embed
node --env-file=.env.local scripts/vault_maintenance.mjs verify --plan=/absolute/plan.json
node --env-file=.env.local scripts/vault_maintenance.mjs apply --apply --plan=/absolute/plan.json --backup=/absolute/backup.json
node --env-file=.env.local scripts/vault_maintenance.mjs plan
```

Use the exact paths printed by `backup` and `embed`. A successful final `plan`
must report zero pending actions for the approved catalogue. Saved-plan reuse
requires exact source text plus matching embedding model/dimensions:
`embed --reuse-plan=/absolute/earlier-plan.json`. The legacy override
`--reuse-model=text-embedding-3-small` is an explicit provenance attestation;
use it only after auditing the producer of an older plan lacking metadata.

Before applying, the tool checks the complete live row digest, project identity,
current catalogues, per-row expectations and all vectors. Application is one
database transaction. It writes secure receipts and a complete post-state
snapshot, then checks every requested field, preserved fields, merge pointers,
UUIDs and float32 vector values. An ambiguous network outcome or failed
post-check requires reading the receipt and live state before any retry.

The old sequential rollback is disabled because it could delete unrelated later
additions. Recovery requires a reviewed transaction with an exact post-state
guard: restore affected original UUIDs and remove only insert UUIDs listed in
the specific apply receipt. Do not delete every row absent from an old backup.

Legacy `ingest_research.mjs` and `curate_research.mjs --ingest` refuse writes while
the reviewed catalogues exist. Curator dry runs remain available. A future
curation round needs a newly reviewed baseline and manifests; do not relax drift
checks merely to force conflicting live edits through.

## Retrieval and verification

The small active corpus is scored using BM25F over title, aliases, summary,
best-for and content, plus cosine similarity. The lexical query is the original
intent, not generated HyDE text. A bounded lexical contribution and explicit
method-name matching disambiguate close optimization siblings. Raw cosine is
preserved as `similarity`; `hybridScore` is only an ordering score. Category
diversity is a preference and can replace the third same-category match.

Live metadata is cached for 60 seconds; the fresh lifecycle-filtered semantic
RPC determines candidate membership, so stale cached retired records cannot
return. New RPC IDs trigger a metadata refresh. This implementation is intended
for a small curated vault, not an unbounded research index. Revisit server-side
lexical retrieval and pagination before growing beyond the RPC row limit.

```sh
npm test
npm run build
node --env-file=.env.local scripts/vault_probe.mjs
node --env-file=.env.local scripts/vault_probe.mjs --hyde
node --env-file=.env.local scripts/vault_probe.mjs --hyde --repeat=3 --only=2,3
```

Probes read the **live RPC by default**. `--plan=/absolute/plan.json` explicitly
simulates planned changes. Probes never call `/api/orchestrate` or write
`prompt_metrics`; they do make embedding calls and optionally HyDE model calls.
They report HyDE fallbacks rather than counting a fallback as a successful
rewrite test. Passing these bounded retrieval checks does not demonstrate
end-to-end generation quality or universal robustness.
