// =============================================================================
// Tests for the vault migration planner, the retrieval diversifier, and the
// curated catalogues themselves.
//
// The catalogue tests are as important as the code tests here: the failure
// this migration exists to fix (two cards citing entirely unrelated papers)
// was a DATA defect that no amount of correct code would have caught.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildPlan, validatePlan, toRpcPayload,
  normalizeCanonicalId, normalizeTitle, normalizeUrl, dedupKeys,
  VALID_CATEGORIES, EMBEDDING_DIM, md5,
} from "../vaultPlan.mjs";
import { diversifyByCategory, candidateCount } from "../vaultRetrieval.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (f) => JSON.parse(readFileSync(resolve(ROOT, "data/vault", f), "utf8"));

const EXISTING   = load("active_existing.json").records;
const ADDITIONS  = load("active_additions.json").records;
const REFONLY    = load("reference_only.json").records;
const WATCHLIST  = load("watchlist.json").records;
const INDUSTRY   = load("industry_references.json").records;

const vec = (fill = 0.01) => new Array(EMBEDDING_DIM).fill(fill);

/** Minimal live-row fixture matching a catalogue record. */
function liveRowFor(rec, overrides = {}) {
  return {
    id: rec.live_id,
    title: rec.current_title,
    content: `ORIGINAL CONTENT for ${rec.current_title}`,
    status: "active",
    retrieval_enabled: true,
    ...overrides,
  };
}

// ── 1. The two broken citations must never be active again ───────────────────

const BROKEN_CITATIONS = [
  { id: "2307.10735", was: "pion physics paper, cited as Skeleton-of-Thought" },
  { id: "2311.11432", was: "mechanical engineering paper, cited as Meta-Prompting" },
];

test("broken citations: neither unrelated arXiv id appears as an active citation_url", () => {
  const activeRecords = [
    ...EXISTING.filter((r) => (r.set?.status ?? "active") === "active"),
    ...ADDITIONS,
  ];
  for (const { id, was } of BROKEN_CITATIONS) {
    for (const rec of activeRecords) {
      const url = rec.set?.citation_url ?? "";
      assert.ok(!url.includes(id), `active record "${rec.set?.title}" still cites ${id} (${was})`);
      assert.notEqual(normalizeCanonicalId(rec.set?.canonical_id), `arxiv:${id}`);
      assert.notEqual(rec.set?.arxiv_id, id);
    }
  }
});

test("broken citations: each replacement records what it replaced", () => {
  // A corrected URL alone is not evidence of review. Every REPLACE driven by a
  // broken citation must say, in the row itself, which identifier it replaced —
  // so the correction is auditable after the fact.
  const replacements = EXISTING.filter((r) => r.action === "REPLACE" && /BROKEN CITATION/.test(r.reason ?? ""));
  assert.equal(replacements.length, 2, "expected exactly two broken-citation replacements");
  for (const rec of replacements) {
    const note = rec.set?.review_note ?? "";
    assert.ok(/replaced/i.test(note), `${rec.current_title}: review_note must state the replacement`);
    const mentions = BROKEN_CITATIONS.some(({ id }) => note.includes(id) || (rec.reason ?? "").includes(id));
    assert.ok(mentions, `${rec.current_title}: must name the broken identifier it replaced`);
  }
});

test("verification discipline: every catalogue record carries a verified_source", () => {
  // URL reachability alone is insufficient — both broken citations resolved
  // fine. Each record must carry the note from the title/author check.
  for (const rec of [...EXISTING, ...ADDITIONS, ...REFONLY]) {
    const vs = rec.verified_source ?? "";
    assert.ok(vs.length > 20, `${rec.current_title ?? rec.key}: missing/implausible verified_source`);
    assert.ok(/verified 2026-09-22|verified 2026/.test(vs), `${rec.current_title ?? rec.key}: verified_source lacks a verification date`);
  }
});

// ── 2. Deduplication ─────────────────────────────────────────────────────────

test("dedup: arXiv version suffixes and case normalize to one key", () => {
  assert.equal(normalizeCanonicalId("arXiv:2507.19457v2"), "arxiv:2507.19457");
  assert.equal(normalizeCanonicalId("arxiv:2507.19457"),   "arxiv:2507.19457");
  assert.equal(normalizeCanonicalId("ARXIV:2507.19457V11"), "arxiv:2507.19457");
});

test("dedup: title normalization ignores case, dashes and punctuation", () => {
  assert.equal(normalizeTitle("Chain-of-Thought (CoT)"), normalizeTitle("chain of thought  (cot)"));
  assert.equal(normalizeTitle("Tree of Thoughts"), normalizeTitle("Tree-of-Thoughts"));
});

test("dedup: URL normalization ignores protocol, www and trailing slash", () => {
  assert.equal(
    normalizeUrl("https://www.aclanthology.org/2024.findings-acl.21/"),
    normalizeUrl("http://aclanthology.org/2024.findings-acl.21")
  );
});

test("dedup: OpenReview paper ids remain distinct while tracking noise is ignored", () => {
  assert.notEqual(
    normalizeUrl("https://openreview.net/forum?id=Bb4VGOWELI"),
    normalizeUrl("https://openreview.net/forum?id=RQm2KQTM5r")
  );
  assert.equal(
    normalizeUrl("https://openreview.net/forum?utm_source=mail&id=RQm2KQTM5r#discussion"),
    normalizeUrl("https://openreview.net/forum?id=RQm2KQTM5r")
  );
});

test("dedup: a record exposes canonical, doi, arxiv, url and alias keys", () => {
  const keys = dedupKeys({
    title: "GEPA",
    canonical_id: "openreview:RQm2KQTM5r",
    arxiv_id: "2507.19457",
    citation_url: "https://openreview.net/forum?id=RQm2KQTM5r",
    aliases: ["reflective prompt evolution"],
  });
  assert.ok(keys.includes("canonical:openreview:rqm2kqtm5r"));
  assert.ok(keys.includes("canonical:arxiv:2507.19457"));
  assert.ok(keys.some((k) => k.startsWith("url:openreview.net")));
  assert.ok(keys.includes(`title:${normalizeTitle("reflective prompt evolution")}`));
});

test("dedup: inserting a duplicate canonical id is an error", () => {
  const live = [{ id: "u1", title: "Existing", content: "c", status: "active", canonical_id: "arxiv:2507.19457" }];
  const plan = buildPlan({
    existing: [{ live_id: "u1", current_title: "Existing", action: "KEEP", set: {} }],
    additions: [{ key: "dup", set: {
      title: "A Different Title", content: "x", summary: "s", best_for: "b",
      category: "Optimization", citation_url: "https://example.org/x",
      canonical_id: "arXiv:2507.19457v3",
    } }],
    liveRows: live,
  });
  assert.ok(plan.errors.some((e) => /duplicate canonical:arxiv:2507\.19457/.test(e)),
    `expected duplicate-canonical error, got: ${JSON.stringify(plan.errors)}`);
});

// ── 3. CAPO acronym collision ────────────────────────────────────────────────

test("CAPO: the three distinct CAPO papers are kept apart", () => {
  const capoActive = ADDITIONS.find((r) => r.key === "capo-cost-aware");
  assert.ok(capoActive, "cost-aware CAPO must be an active addition");
  assert.equal(normalizeCanonicalId(capoActive.set.canonical_id), "pmlr:v293-zehle25a");

  // The constraint-aware CAPO must be on the watchlist, NOT active, and must be
  // recorded under a different canonical id.
  const capoWatch = WATCHLIST.find((r) => normalizeCanonicalId(r.canonical_id) === "arxiv:2608.16068");
  assert.ok(capoWatch, "constraint-aware CAPO must be on the watchlist");
  assert.notEqual(
    normalizeCanonicalId(capoWatch.canonical_id),
    normalizeCanonicalId(capoActive.set.canonical_id),
    "the two CAPO papers must not share a canonical id"
  );

  // The bare acronym must never be the sole identity of the active record.
  assert.notEqual(normalizeTitle(capoActive.set.title), normalizeTitle("CAPO"));
  // And the active record must explicitly disambiguate.
  const rel = JSON.stringify(capoActive.set.related_citations ?? []);
  assert.ok(/2608\.16068/.test(rel), "active CAPO must point at the colliding paper to disambiguate");
});

test("CAPO: watchlist records the collision explicitly", () => {
  const capoWatch = WATCHLIST.find((r) => normalizeCanonicalId(r.canonical_id) === "arxiv:2608.16068");
  assert.ok(/collision/i.test(capoWatch.defer_reason), "collision must be documented in defer_reason");
});

// ── 4. Non-active rows can never enter retrieval ─────────────────────────────

test("retrieval exclusion: no catalogue record is non-active AND retrieval-enabled", () => {
  const all = [...EXISTING, ...ADDITIONS, ...REFONLY];
  for (const rec of all) {
    const s = rec.set ?? {};
    if (s.status != null && s.status !== "active") {
      assert.equal(s.retrieval_enabled, false,
        `${rec.current_title ?? rec.key}: status="${s.status}" must have retrieval_enabled=false`);
    }
  }
});

test("retrieval exclusion: planner rejects retrieval_enabled=true on a non-active row", () => {
  const live = [{ id: "u1", title: "T", content: "c", status: "active" }];
  const plan = buildPlan({
    existing: [{
      live_id: "u1", current_title: "T", action: "ARCHIVE",
      set: { status: "archived", retrieval_enabled: true },
    }],
    liveRows: live,
  });
  assert.ok(plan.errors.some((e) => /illegal with status="archived"/.test(e)));
});

test("retrieval exclusion: archived, merged and reference_only are all excluded", () => {
  const archived = EXISTING.filter((r) => r.action === "ARCHIVE");
  const merged   = EXISTING.filter((r) => r.action === "MERGE");
  assert.equal(archived.length, 2, "expected EmotionPrompt and Toolformer archived");
  assert.equal(merged.length, 1, "expected Constitutional AI merged");
  for (const r of [...archived, ...merged]) assert.equal(r.set.retrieval_enabled, false);
  for (const r of REFONLY) {
    assert.equal(r.set.status, "reference_only");
    assert.equal(r.set.retrieval_enabled, false);
  }
});

test("retrieval exclusion: watchlist and industry catalogues are never ingested", () => {
  // These are file-only by design. If someone adds a `set` block with an
  // active status, they have started turning them into DB rows — fail loudly.
  for (const r of [...WATCHLIST, ...INDUSTRY]) {
    assert.equal(r.set, undefined,
      `${r.proposed_name ?? r.product_name}: watchlist/industry records must not carry a DB "set" block`);
  }
});

// ── 5. Embedding policy ──────────────────────────────────────────────────────

test("embedding: changed content requires a new embedding", () => {
  const rec = { live_id: "u1", current_title: "T", action: "MODIFY", embed_required: true,
                set: { content: "NEW TEXT" } };
  const live = [{ id: "u1", title: "T", content: "OLD TEXT", status: "active" }];
  const plan = buildPlan({ existing: [rec], liveRows: live });
  assert.equal(plan.errors.length, 0, JSON.stringify(plan.errors));
  assert.equal(plan.actions[0]._meta.embed_required, true);

  // Without the vector attached, the final gate must fail.
  const failed = validatePlan(plan, { liveRows: live });
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.some((e) => /no embedding attached/.test(e)));

  plan.actions[0].embedding = vec();
  assert.equal(validatePlan(plan, { liveRows: live }).ok, true);
});

test("embedding: metadata-only change must NOT carry an embedding", () => {
  const rec = { live_id: "u1", current_title: "T", action: "ARCHIVE", embed_required: false,
                set: { status: "archived", retrieval_enabled: false } };
  const live = [{ id: "u1", title: "T", content: "SAME", status: "active" }];
  const plan = buildPlan({ existing: [rec], liveRows: live });
  assert.equal(plan.actions[0]._meta.embed_required, false);

  plan.actions[0].embedding = vec();
  const r = validatePlan(plan, { liveRows: live });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /would overwrite a valid vector/.test(e)));
});

test("embedding: wrong dimension and non-finite values are rejected", () => {
  const mk = (embedding) => {
    const live = [{ id: "u1", title: "T", content: "OLD", status: "active" }];
    const plan = buildPlan({
      existing: [{ live_id: "u1", current_title: "T", action: "MODIFY", embed_required: true, set: { content: "NEW" } }],
      liveRows: live,
    });
    plan.actions[0].embedding = embedding;
    return validatePlan(plan, { liveRows: live });
  };
  assert.ok(mk(new Array(768).fill(0.1)).errors.some((e) => /768 dims/.test(e)));
  const bad = vec(); bad[5] = NaN;
  assert.ok(mk(bad).errors.some((e) => /non-finite/.test(e)));
});

test("embedding: every catalogue insert is marked as requiring one", () => {
  const live = [];
  const plan = buildPlan({ additions: ADDITIONS, referenceOnly: REFONLY, liveRows: live });
  const inserts = plan.actions.filter((a) => a.op === "insert");
  assert.equal(inserts.length, ADDITIONS.length + REFONLY.length);
  for (const a of inserts) assert.equal(a._meta.embed_required, true, `${a.label} must require an embedding`);
});

// ── 6. Fail closed on drift ──────────────────────────────────────────────────

test("drift: a missing target id is an error, never a title-based guess", () => {
  const plan = buildPlan({
    existing: [{ live_id: "does-not-exist", current_title: "T", action: "MODIFY", set: {} }],
    liveRows: [{ id: "other", title: "T", content: "c", status: "active" }],
  });
  assert.ok(plan.errors.some((e) => /not found — refusing to guess by title/.test(e)));
});

test("drift: a renamed live row is an error", () => {
  const plan = buildPlan({
    existing: [{ live_id: "u1", current_title: "Old Name", action: "MODIFY", set: {} }],
    liveRows: [{ id: "u1", title: "Renamed In DB", content: "c", status: "active" }],
  });
  assert.ok(plan.errors.some((e) => /title drift/.test(e)));
});

test("drift: an uncovered live row is an error", () => {
  const plan = buildPlan({
    existing: [],
    liveRows: [{ id: "u1", title: "Orphan", content: "c", status: "active" }],
  });
  assert.ok(plan.errors.some((e) => /has no disposition in the catalogue/.test(e)));
});

test("drift: every update carries a content_md5 guard for optimistic concurrency", () => {
  const live = [{ id: "u1", title: "T", content: "ORIGINAL", status: "active" }];
  const plan = buildPlan({
    existing: [{ live_id: "u1", current_title: "T", action: "KEEP", embed_required: false, set: { summary: "Reviewed summary" } }],
    liveRows: live,
  });
  assert.equal(plan.actions[0].expect.content_md5, md5("ORIGINAL"));
  assert.equal(plan.actions[0].expect.title, "T");
});

function appliedCatalogueRows() {
  return [
    ...EXISTING.map((r) => ({
      ...liveRowFor(r), ...r.set, embedding: vec(),
      ...(r.merge_into_live_id ? { merged_into: r.merge_into_live_id } : {}),
    })),
    ...[...ADDITIONS, ...REFONLY].map((r, i) => ({ id: `inserted-${i}`, ...r.set, embedding: vec() })),
  ];
}

test("idempotence: a fully applied catalogue plans zero writes and embeddings", () => {
  const liveRows = appliedCatalogueRows();
  const plan = buildPlan({ existing: EXISTING, additions: ADDITIONS, referenceOnly: REFONLY, liveRows });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.stats.unchanged, liveRows.length);
  assert.equal(plan.stats.embeddings_required, 0);
  const validation = validatePlan(plan, { liveRows });
  assert.equal(validation.ok, true);
  assert.equal(validation.reconciliation.physical_after, liveRows.length);
});

test("idempotence: jsonb object-key order does not produce phantom updates", () => {
  const liveRows = appliedCatalogueRows();
  for (const row of liveRows) {
    if (row.related_citations) {
      row.related_citations = row.related_citations.map((citation) =>
        Object.fromEntries(Object.entries(citation).reverse())
      );
    }
  }
  const plan = buildPlan({ existing: EXISTING, additions: ADDITIONS, referenceOnly: REFONLY, liveRows });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.actions.length, 0);
});

test("drift: previously applied additions with conflicting fields fail closed", () => {
  const liveRows = appliedCatalogueRows();
  liveRows.find((r) => r.canonical_id === ADDITIONS[0].set.canonical_id).summary = "Changed since review";
  const plan = buildPlan({ existing: EXISTING, additions: ADDITIONS, referenceOnly: REFONLY, liveRows });
  assert.ok(plan.errors.some((e) => /existing addition diverges.*summary/.test(e)));
});

test("drift: changed content on a previously curated original fails closed", () => {
  const liveRows = appliedCatalogueRows();
  liveRows[0].content = "Concurrent editorial change";
  const plan = buildPlan({ existing: EXISTING, additions: ADDITIONS, referenceOnly: REFONLY, liveRows });
  assert.ok(plan.errors.some((e) => /already-curated row diverges.*content/.test(e)));
});

test("merge: persist the destination and fill a missing pointer without re-embedding", () => {
  const liveRows = appliedCatalogueRows();
  const mergeRecord = EXISTING.find((r) => r.merge_into_live_id);
  delete liveRows.find((r) => r.id === mergeRecord.live_id).merged_into;
  const plan = buildPlan({ existing: EXISTING, additions: ADDITIONS, referenceOnly: REFONLY, liveRows });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].set.merged_into, mergeRecord.merge_into_live_id);
  assert.equal(plan.actions[0]._meta.embed_required, false);
  assert.equal(toRpcPayload(plan, { expectedRowCount: liveRows.length }).actions[0].set.merged_into,
    mergeRecord.merge_into_live_id);
});

test("validation: lifecycle checks include inherited live values", () => {
  const plan = buildPlan({
    existing: [{ live_id: "u1", current_title: "T", action: "ARCHIVE", set: { status: "archived" } }],
    liveRows: [{ id: "u1", title: "T", content: "c", status: "active", retrieval_enabled: true }],
  });
  assert.ok(plan.errors.some((e) => /illegal with status="archived"/.test(e)));
});

// ── 7. Full-catalogue plan builds cleanly ────────────────────────────────────

test("full catalogue: builds with zero errors against a faithful live snapshot", () => {
  const liveRows = EXISTING.map((r) => liveRowFor(r));
  const plan = buildPlan({
    existing: EXISTING, additions: ADDITIONS, referenceOnly: REFONLY, liveRows,
  });
  assert.deepEqual(plan.errors, [], `planner errors: ${JSON.stringify(plan.errors, null, 2)}`);
  assert.equal(plan.stats.updates, 22);
  assert.equal(plan.stats.inserts, ADDITIONS.length + REFONLY.length);
  assert.equal(plan.stats.physical_after, 22 + ADDITIONS.length + REFONLY.length);
});

test("full catalogue: reconciliation arithmetic balances and deletes nothing", () => {
  const liveRows = EXISTING.map((r) => liveRowFor(r));
  const plan = buildPlan({ existing: EXISTING, additions: ADDITIONS, referenceOnly: REFONLY, liveRows });
  for (const a of plan.actions) if (a._meta.embed_required) a.embedding = vec();
  const res = validatePlan(plan, { liveRows });

  assert.equal(res.ok, true, JSON.stringify(res.errors, null, 2));
  const r = res.reconciliation;
  assert.equal(r.physical_deletions, 0, "archival-only policy: nothing may be deleted");
  assert.equal(r.physical_before + r.inserted - r.physical_deletions, r.physical_after);
  // 3 of the 22 existing rows leave the active set (2 archived + 1 merged).
  assert.equal(r.active_after, r.physical_after - 3 - REFONLY.length);
  // Reference-only rows are active-excluded AND retrieval-excluded.
  assert.equal(r.retrievable_after, r.active_after);
});

test("full catalogue: every active record uses a valid category", () => {
  for (const rec of [...EXISTING, ...ADDITIONS]) {
    const s = rec.set ?? {};
    if ((s.status ?? "active") !== "active") continue;
    if (s.category == null) continue;
    assert.ok(VALID_CATEGORIES.includes(s.category), `${s.title}: bad category ${s.category}`);
  }
});

test("full catalogue: every active record states limitations", () => {
  // A card without limitations is how overclaiming gets back in.
  for (const rec of [...EXISTING, ...ADDITIONS]) {
    const s = rec.set ?? {};
    if ((s.status ?? "active") !== "active" || s.content == null) continue;
    assert.ok((s.limitations ?? "").length > 30, `${s.title}: active card must state limitations`);
  }
});

test("full catalogue: no active card claims universal improvement", () => {
  const banned = [
    /\balways improves\b/i, /\bguarantees?\b/i, /\beliminates hallucination/i,
    /\bproduction[- ]ready\b/i, /\buniversally\b/i, /\bin all cases\b/i,
  ];
  // A banned word inside a DISCLAIMER is the opposite of an overclaim — the
  // Self-Consistency card correctly says it is "not a factuality guarantee".
  // Only flag a match that is not negated in the preceding clause.
  const NEGATION = /\b(not|never|cannot|can't|no|without|isn'?t|does not|doesn'?t|rather than)\b[^.]{0,60}$/i;
  const isNegated = (text, index) => NEGATION.test(text.slice(Math.max(0, index - 80), index));

  for (const rec of [...EXISTING, ...ADDITIONS]) {
    const s = rec.set ?? {};
    if ((s.status ?? "active") !== "active" || !s.content) continue;
    for (const re of banned) {
      const m = new RegExp(re.source, "gi");
      let hit;
      while ((hit = m.exec(s.content)) !== null) {
        assert.ok(isNegated(s.content, hit.index),
          `${s.title}: unqualified overclaim "${hit[0]}" — "${s.content.slice(Math.max(0, hit.index - 60), hit.index + 40)}"`);
      }
    }
  }
});

test("full catalogue: no active card recommends exposing chain-of-thought", () => {
  for (const rec of [...EXISTING, ...ADDITIONS]) {
    const s = rec.set ?? {};
    if (!s.content) continue;
    assert.ok(!/\bshow (?:the )?(?:model'?s )?(?:chain[- ]of[- ]thought|reasoning) to (?:the )?user/i.test(s.content),
      `${s.title}: must not recommend exposing private reasoning`);
  }
});

test("toRpcPayload strips planner metadata", () => {
  const liveRows = [{ id: "u1", title: "T", content: "OLD", status: "active" }];
  const plan = buildPlan({
    existing: [{ live_id: "u1", current_title: "T", action: "MODIFY", embed_required: true, set: { content: "NEW" } }],
    liveRows,
  });
  plan.actions[0].embedding = vec();
  const payload = toRpcPayload(plan, { expectedRowCount: 1 });
  assert.equal(payload.expected_row_count, 1);
  assert.equal(payload.actions[0]._meta, undefined);
  assert.equal(payload.actions[0].expect.content_md5, md5("OLD"));
});

// ── 8. Retrieval diversification ─────────────────────────────────────────────

test("diversify: caps a dominant category but preserves relevance order", () => {
  const rows = [
    { title: "opt1", category: "Optimization", similarity: 0.90 },
    { title: "opt2", category: "Optimization", similarity: 0.88 },
    { title: "opt3", category: "Optimization", similarity: 0.86 },
    { title: "str1", category: "Structure",    similarity: 0.60 },
  ];
  const out = diversifyByCategory(rows, { limit: 3, maxPerCategory: 2 });
  assert.deepEqual(out.map((r) => r.title), ["opt1", "opt2", "str1"]);
  // strictly descending similarity
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].similarity >= out[i].similarity);
});

test("diversify: never returns fewer than limit when candidates exist", () => {
  const rows = [
    { title: "a", category: "Optimization", similarity: 0.9 },
    { title: "b", category: "Optimization", similarity: 0.8 },
    { title: "c", category: "Optimization", similarity: 0.7 },
  ];
  const out = diversifyByCategory(rows, { limit: 3, maxPerCategory: 2 });
  assert.equal(out.length, 3, "cap is a preference, not a reason to return short");
  assert.deepEqual(out.map((r) => r.title), ["a", "b", "c"]);
});

test("diversify: never promotes a weaker match above a stronger one", () => {
  const rows = [
    { title: "strong", category: "Optimization", similarity: 0.95 },
    { title: "weak",   category: "Retrieval",    similarity: 0.20 },
  ];
  const out = diversifyByCategory(rows, { limit: 2, maxPerCategory: 1 });
  assert.equal(out[0].title, "strong");
});

test("diversify: handles empty, short and uncategorized input", () => {
  assert.deepEqual(diversifyByCategory([], { limit: 3 }), []);
  assert.deepEqual(diversifyByCategory(null, { limit: 3 }), []);
  assert.equal(diversifyByCategory([{ similarity: 0.5 }, { similarity: 0.4 }], { limit: 3 }).length, 2);
});

test("candidateCount over-fetches so the reranker has choices", () => {
  assert.ok(candidateCount(3) > 3);
  assert.equal(candidateCount(3, { factor: 4, max: 20 }), 12);
  assert.equal(candidateCount(10, { factor: 4, max: 20 }), 20);
});
