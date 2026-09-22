# Vault curation and hybrid retrieval — 22 September 2026

## Completed live application

The initial live audit found lifecycle columns installed but only the original
22 records, all active, with no canonical IDs populated. The approved row plan
had not been applied.

The strengthened `apply_vault_migration` function was installed and verified in
the live Supabase project. It holds a table write lock through validation and
application, requires optimistic guards, validates embedding/content coupling,
supports explicit-null metadata updates, and limits execution to `service_role`.
Live checks confirmed that `anon` and `authenticated` cannot execute it.

At 13:17 UTC, the approved plan applied in one transaction:

| Result | Count |
| --- | ---: |
| Original records updated | 22 |
| New records inserted | 18 |
| Physical records after application | 40 |
| Active and retrieval-enabled | 35 |
| Archived | 2 |
| Merged | 1 |
| Reference-only | 2 |
| Physical deletions | 0 |

All requested metadata fields and embeddings passed post-state verification.
Constitutional AI now explicitly points to Self-Refine as its merge destination.
Thirty-seven embeddings were reused from the audited earlier plan because the
source text and production embedding configuration matched; no replacement
embedding generation was needed. The three retired/merged rows kept their
original embeddings. A fresh planner run returned zero updates, inserts or
embeddings required. The live semantic RPC returned all 35 active UUIDs.

No `prompt_metrics` writes were performed. The generation endpoint was not used
for these checks. Database snapshots and full vectors were kept outside Git.

Recovery evidence is in the private `~/.promptpilot-vault-backups` directory:

- Pre-state: `prompt_research_2026-09-22T13-05-09-813Z.json`
- Executed plan: `vault_plan_2026-09-22T13-05-20-621Z.json`
- Receipt: `vault_apply_receipt_2026-09-22T13-17-45-699Z.json`
- Verification: `vault_apply_verification_2026-09-22T13-17-45-699Z.json`
- Post-state: `vault_post_state_2026-09-22T13-17-45-699Z.json`

Post-state full-row SHA-256:
`c64333a2ac33721e3347269f7ebfd487e394f73acf58ea0ca8a6717690dcc9aa`.

## Retrieval fix and validation

The app now combines BM25F lexical scores from the **original user intent** with
semantic cosine scores across the active corpus. It does not cut candidates to
a semantic top-k before lexical fusion. Live-derived vocabulary replaces the
stale hardcoded technique list, and archived/merged/reference-only records are
excluded from the corpus, semantic RPC and Vault page. A new semantic-cache
namespace avoids serving pre-curation cached generations after code deployment.

The TRAS wording supplied by Claude was retained; no further source wording was
tuned to these probes. A regression models the reported cosine gap (TRAS 0.638,
PE2 0.738) and verifies recovery from below the top seven without changing the
raw similarity values. Tests also perturb semantic scores and anonymize method
names to check mechanism-based matching rather than a TRAS-specific rule.

| Verification | Result |
| --- | --- |
| Repository unit/integration tests | 93 passed |
| Isolated PostgreSQL/pgvector maintenance assertions | 21 passed |
| Production build | Passed |
| Lint on all changed JavaScript modules/tests | Passed with installed Next core-web-vitals config |
| Simulated post-plan direct-query retrieval probes | 10/10 passed |
| Live RPC + fresh HyDE rewrite probes | 10/10 passed, no fallback |
| Additional TRAS drift probe repetitions | 3/3 passed, TRAS ranked first each time |
| Additional GMPO segment/multi-judge repetitions | 3/3 passed, GMPO ranked first each time |

TRAS semantic-only ranks in the additional repetitions were 1, 4 and 1; hybrid
rank was 1 in each. Its cosine scores were 0.757, 0.722 and 0.769. GMPO cosine
scores were 0.807, 0.758 and 0.784. These bounded tests address the reported
instability; they do not establish universal retrieval or final-answer quality.

The repository's plain `npm run lint` remains unconfigured (no flat ESLint
configuration). Validation used `npx eslint --config
node_modules/eslint-config-next/dist/core-web-vitals.js` with the changed files
explicitly listed. No unrelated lint configuration or dependencies were added.

Unsafe sequential rollback was disabled. Legacy seed ingestion and curator
insertion are blocked while the reviewed manifests are authoritative, preventing
older citations and renamed records from being reintroduced. See
[Vault maintenance](vault-maintenance.md) for recovery and future curation.

The live database state is verified here; a hosted application deployment is a
separate result from committing and pushing the application code.
