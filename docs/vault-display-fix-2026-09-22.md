# Vault display correction — 22 September 2026

The production URL `https://promptpilot-two.vercel.app/vault` was inspected in a
browser and displayed **19 entries**. This was a display-policy bug, not a failed
database curation or stale deployment: production had deployed commit `daaaf20`,
and the live database contained 35 active, retrieval-enabled records.

The page also required `is_featured = true`. Only 19 active records carry that
editorial flag: 13 original records and six additions. Thus six original active
sources and ten new active sources were hidden from the full-corpus browser.
The earlier curation verification checked retrieval, but missed this UI filter.

## Fix

- Display every active, retrieval-enabled source, independently of `is_featured`.
- Continue excluding archived, merged, reference-only and disabled records.
- Paginate the server query instead of silently relying on a default row limit.
- Derive category chips and counts from the displayed corpus, including
  Optimization, Agentic, Evaluation and Retrieval. The old fixed four-category
  list did not cover the active corpus.
- Search aliases as well as titles, summaries, use cases and categories.
- Clarify that sources are available for retrieval, not all used on every request.

No database data or `prompt_metrics` writes are needed for this correction.

## Verification before deployment

- 102 repository tests passed, including nine new Vault-display regressions.
- Production build and targeted Next ESLint checks passed.
- Browser-tested the built application against the live database: 35 cards,
  Optimization filter shows 15, searching TRAS shows one, and clearing filters
  restores all 35.
- Category counts: Reasoning 5, Structure 5, Accuracy 2, Advanced 3, Agentic 3,
  Evaluation 1, Optimization 15 and Retrieval 1.

This report distinguishes the corrected local build from production. GitHub's
main-branch rule requires a pull request and one independent approval. The fix
must pass that normal review/merge path before the production URL can be
claimed corrected. Do not bypass the approval requirement or alter editorial
database flags simply to make the count change before deployment.
