// =============================================================================
// Vault migration planner — PURE functions, no I/O.
//
// Turns the reviewed catalogues in data/vault/ plus a snapshot of the live
// prompt_research rows into a machine-readable change plan that
// apply_vault_migration(jsonb, boolean) can execute in one transaction.
//
// Everything here is deterministic and dependency-free so it can be unit
// tested without a database, a network, or an embedding provider. The CLI in
// scripts/vault_maintenance.mjs supplies the I/O.
//
// FAIL CLOSED: buildPlan collects errors rather than throwing, and the CLI
// refuses to emit a plan when errors is non-empty. A missing or drifted target
// is an error, never a silently skipped action.
// =============================================================================

import { createHash } from "node:crypto";

export const VALID_CATEGORIES = [
  "Reasoning", "Structure", "Accuracy", "Advanced", "Agentic",
  "Evaluation", "Optimization", "Alignment", "Retrieval",
];

export const VALID_STATUSES = [
  "active", "reference_only", "watch", "archived", "merged", "superseded",
];

export const VALID_SOURCE_TYPES = [
  "peer_reviewed_paper", "preprint", "survey", "vendor_blog", "vendor_docs",
  "product_docs", "book",
];

export const VALID_EVIDENCE_STATUSES = [
  "peer_reviewed", "preprint", "author_claimed_venue", "vendor_reported",
  "derived_guidance", "unverified",
];

export const EMBEDDING_DIM = 1024;

export const md5 = (s) => createHash("md5").update(s ?? "", "utf8").digest("hex");
export const sha256 = (s) => createHash("sha256").update(s ?? "", "utf8").digest("hex");

// ── Normalization used for deduplication ─────────────────────────────────────
//
// Dedup order (per the curation policy):
//   1. canonical identifier   2. normalized URL
//   3. normalized title/alias 4. semantic similarity (curator judgement)
// Only 1-3 are mechanical and therefore implemented here. Semantic overlap is
// an editorial decision recorded in the catalogue, not something this module
// decides.

/** arXiv:2201.11903v2 → arxiv:2201.11903 ; trailing punctuation stripped. */
export function normalizeCanonicalId(id) {
  if (typeof id !== "string") return null;
  let s = id.trim().toLowerCase().replace(/[.,;]+$/, "");
  if (!s) return null;
  s = s.replace(/^arxiv:\s*/, "arxiv:").replace(/^doi:\s*/, "doi:");
  // Drop an arXiv version suffix: 2507.19457v2 → 2507.19457
  s = s.replace(/^(arxiv:\d{4}\.\d{4,5})v\d+$/, "$1");
  return s;
}

/** Case/punctuation-insensitive title key. "Chain-of-Thought (CoT)" → "chainofthought cot" */
export function normalizeTitle(t) {
  if (typeof t !== "string") return null;
  const s = t.toLowerCase()
    .replace(/[‐-―]/g, "-")   // unicode dashes → hyphen
    .replace(/[^a-z0-9()\s-]/g, "")
    // Hyphens become SPACES, not nothing: "Chain-of-Thought" and
    // "chain of thought" must collapse to the same key. Deleting the hyphen
    // instead yields "chainofthought", which silently fails to dedupe the two
    // spellings — the exact collision this normalizer exists to catch.
    .replace(/-/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** Ignore transport/tracking noise, but preserve query parameters that identify a paper. */
export function normalizeUrl(u) {
  if (typeof u !== "string") return null;
  try {
    const parsed = new URL(u.trim());
    const host = parsed.host.replace(/^www\./, "").toLowerCase();
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    const query = parsed.searchParams.toString();
    return `${host}${path}${query ? `?${query}` : ""}` || null;
  } catch {
    return null;
  }
}

/** Every mechanical dedup key a record exposes. */
export function dedupKeys(rec) {
  const keys = [];
  const cid = normalizeCanonicalId(rec.canonical_id);
  if (cid) keys.push(`canonical:${cid}`);
  const doi = normalizeCanonicalId(rec.doi ? `doi:${rec.doi}` : null);
  if (doi) keys.push(`canonical:${doi}`);
  const ax = normalizeCanonicalId(rec.arxiv_id ? `arxiv:${rec.arxiv_id}` : null);
  if (ax) keys.push(`canonical:${ax}`);
  const url = normalizeUrl(rec.citation_url);
  if (url) keys.push(`url:${url}`);
  const title = normalizeTitle(rec.title);
  if (title) keys.push(`title:${title}`);
  for (const a of rec.aliases ?? []) {
    const na = normalizeTitle(a);
    if (na) keys.push(`title:${na}`);
  }
  return keys;
}

// ── Field validation ─────────────────────────────────────────────────────────

const INSERT_REQUIRED = ["title", "content", "summary", "best_for", "category", "citation_url"];

// Postgres jsonb reorders object keys. Comparing serialized input directly
// would turn every already-applied related_citations object into a false diff.
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function changedFields(live, desired) {
  return Object.keys(desired).filter((key) =>
    JSON.stringify(canonicalValue(live[key] ?? null)) !== JSON.stringify(canonicalValue(desired[key] ?? null))
  );
}

function validateSet(set, { isInsert, label, errors }) {
  const err = (m) => errors.push(`${label}: ${m}`);

  if (isInsert) {
    for (const f of INSERT_REQUIRED) {
      if (!set[f] || String(set[f]).trim() === "") err(`insert missing required field "${f}"`);
    }
  }
  if (set.category != null && !VALID_CATEGORIES.includes(set.category)) {
    err(`invalid category "${set.category}"`);
  }
  if (set.status != null && !VALID_STATUSES.includes(set.status)) {
    err(`invalid status "${set.status}"`);
  }
  if (set.source_type != null && !VALID_SOURCE_TYPES.includes(set.source_type)) {
    err(`invalid source_type "${set.source_type}"`);
  }
  if (set.evidence_status != null && !VALID_EVIDENCE_STATUSES.includes(set.evidence_status)) {
    err(`invalid evidence_status "${set.evidence_status}"`);
  }
  // Mirrors the DB CHECK constraint so the planner fails before the database does.
  if (set.retrieval_enabled === true && set.status != null && set.status !== "active") {
    err(`retrieval_enabled=true is illegal with status="${set.status}"`);
  }
  if (set.citation_url != null && !/^https?:\/\//i.test(set.citation_url)) {
    err(`citation_url is not an http(s) URL: "${set.citation_url}"`);
  }
  for (const c of set.related_citations ?? []) {
    if (c.url != null && !/^https?:\/\//i.test(c.url)) {
      err(`related citation URL is not http(s): "${c.url}"`);
    }
  }
}

// ── Plan construction ────────────────────────────────────────────────────────

// ── Revisions ────────────────────────────────────────────────────────────────
//
// Once a curation round is live, its catalogue is a historical record and the
// divergence guard below rejects any edit to an already-curated row — that is
// what stops a stray catalogue change from silently undoing live curation.
// A deliberate follow-up change is expressed instead as a REVISION: it names
// an exact UUID, states the prior value of every field it changes, and applies
// only when the live row is still exactly in that state. Anything else fails
// closed as drift.

const IDENTITY_FIELDS = ["title", "canonical_id", "citation_url", "doi", "arxiv_id"];

function indexRevisions(revisions, errors) {
  // A row may carry an ordered CHAIN of revisions (file order, then array
  // order). An applied revision is history: a later change is a new revision
  // whose `expect` is the state the previous one left behind, never an edit to
  // the old one (which would falsify the prior state it recorded).
  const byId = new Map();
  for (const rev of revisions) {
    const label = `REVISION ${rev.live_id ?? "(no live_id)"}`;
    if (!rev.live_id) { errors.push(`${label}: missing live_id`); continue; }
    const set = rev.set ?? {};
    const expect = rev.expect ?? {};
    if (!Object.keys(set).length) errors.push(`${label}: empty set`);
    for (const key of Object.keys(set)) {
      const covered = key === "content" ? expect.content_md5 != null : Object.hasOwn(expect, key);
      if (!covered) errors.push(`${label}: expect must state the prior value of "${key}"`);
    }
    const chain = byId.get(rev.live_id) ?? { consumed: false, revs: [] };
    chain.revs.push({ ...rev, set, expect });
    byId.set(rev.live_id, chain);
  }
  return byId;
}

function matchesExpect(live, expect) {
  const { content_md5: contentMd5, ...fields } = expect;
  if (contentMd5 != null && md5(live.content) !== contentMd5) return false;
  return changedFields(live, fields).length === 0;
}

/**
 * Walk a row's revision chain in order against a simulated copy of the live
 * row. Revisions already reflected are skipped; the first unapplied one must
 * match the simulated state exactly, and so must each one after it. Returns
 *   { state: "applied" }
 *   { state: "pending", set, contentRev }  — one combined update
 *   { state: "error", message }
 */
function resolveRevisionChain(live, baseSet, chain) {
  const sim = { ...live };
  const pendingSet = {};
  let contentRev = null;
  for (const [i, rev] of chain.revs.entries()) {
    const diffs = changedFields(sim, rev.set);
    if (!diffs.length) continue;
    if (!matchesExpect(sim, rev.expect)) {
      return { state: "error", message: `revision #${i + 1} no longer matches its expected prior state (${diffs.join(", ")})` };
    }
    if (diffs.includes("content") !== (rev.embed_required === true)) {
      return { state: "error", message: `revision #${i + 1}: embed_required must be ${diffs.includes("content")}` };
    }
    for (const k of diffs) { sim[k] = rev.set[k]; pendingSet[k] = rev.set[k]; }
    if (diffs.includes("content")) contentRev = rev;
  }
  const effective = Object.assign({ ...baseSet }, ...chain.revs.map((r) => r.set));
  const outOfScope = changedFields(sim, effective);
  if (outOfScope.length) {
    return { state: "error", message: `row diverges beyond its revisions (${outOfScope.join(", ")})` };
  }
  if (!Object.keys(pendingSet).length) return { state: "applied" };
  return { state: "pending", set: pendingSet, contentRev };
}
/**
 * @param {object}   input
 * @param {object[]} input.existing       - active_existing.json .records
 * @param {object[]} input.additions      - active_additions.json .records
 * @param {object[]} input.referenceOnly  - reference_only.json .records
 * @param {object[]} input.liveRows       - [{id,title,content,status,...}] from the DB
 * @returns {{actions, errors, warnings, stats}}
 */
export function buildPlan({
  existing = [], additions = [], referenceOnly = [], revisions = [], liveRows = [],
  requirePeerReviewed = false,
}) {
  const errors = [];
  const warnings = [];
  const actions = [];
  let unchanged = 0;
  const revById = indexRevisions(revisions, errors);

  const byId = new Map(liveRows.map((r) => [r.id, r]));
  if (byId.size !== liveRows.length) errors.push("live snapshot contains duplicate UUIDs");
  const liveTitleKeys = new Map();
  for (const r of liveRows) {
    const k = normalizeTitle(r.title);
    if (k) liveTitleKeys.set(k, r.id);
  }

  // ── Existing rows ──────────────────────────────────────────────────────────
  const seenIds = new Set();
  for (const rec of existing) {
    const label = `${rec.action} "${rec.current_title}"`;
    const live = byId.get(rec.live_id);

    if (!live) {
      errors.push(`${label}: live_id ${rec.live_id} not found — refusing to guess by title`);
      continue;
    }
    if (seenIds.has(rec.live_id)) {
      errors.push(`${label}: live_id ${rec.live_id} targeted more than once`);
      continue;
    }
    seenIds.add(rec.live_id);

    const set = { ...(rec.set ?? {}) };
    if (rec.merge_into_live_id) {
      if (!byId.has(rec.merge_into_live_id) || rec.merge_into_live_id === rec.live_id) {
        errors.push(`${label}: merge destination must be a different existing row`);
      }
      if (set.merged_into && set.merged_into !== rec.merge_into_live_id) {
        errors.push(`${label}: conflicting merge destinations`);
      }
      set.merged_into = rec.merge_into_live_id;
    }
    const chain = revById.get(rec.live_id);
    if (chain) chain.consumed = true;
    const chainSet = Object.assign({}, ...(chain?.revs ?? []).map((r) => r.set));
    validateSet({ ...live, ...set, ...chainSet }, { isInsert: false, label, errors });

    const knownTitles = [rec.current_title, set.title, ...(chain?.revs ?? []).map((r) => r.set.title)];
    if (!knownTitles.includes(live.title)) {
      errors.push(`${label}: title drift — db has "${live.title}"`);
      continue;
    }

    if (chain) {
      const r = resolveRevisionChain(live, set, chain);
      if (r.state === "applied") { unchanged++; continue; }
      if (r.state === "error") { errors.push(`${label}: ${r.message}`); continue; }
      const contentChanged = r.set.content != null && r.set.content !== live.content;
      actions.push({
        op: "update", label: `REVISION ${label}`, id: rec.live_id,
        expect: { title: live.title, content_md5: md5(live.content), status: live.status ?? "active" },
        set: r.set,
        _meta: { action_kind: "REVISION", embed_required: contentChanged,
                 reason: chain.revs.map((x) => x.reason).filter(Boolean).join(" | "),
                 verified_source: chain.revs.map((x) => x.verified_source).filter(Boolean).join(" | ") },
      });
      continue;
    }

    const differences = changedFields(live, set);
    if (!differences.length) {
      unchanged++;
      continue;
    }

    // A curated identity is evidence that this migration has already run.
    // Filling a newly added, previously empty metadata field is safe, but an
    // existing conflicting value needs review rather than silently undoing it.
    const alreadyCurated = (set.canonical_id && live.canonical_id === set.canonical_id)
      || (live.title !== rec.current_title && live.title === set.title);
    if (alreadyCurated && differences.some((field) => live[field] != null)) {
      errors.push(`${label}: already-curated row diverges from the reviewed catalogue (${differences.join(", ")})`);
      continue;
    }

    // Embedding policy: content change REQUIRES a new vector; a metadata-only
    // change must NOT touch the existing one. Both directions are enforced,
    // because a stale vector paired with new text is silently wrong.
    const contentChanged = set.content != null && set.content !== live.content;
    if (contentChanged && rec.embed_required !== true) {
      errors.push(`${label}: content changes but embed_required is not true`);
    }

    actions.push({
      op: "update",
      label,
      id: rec.live_id,
      expect: {
        title: live.title,
        content_md5: md5(live.content),
        status: live.status ?? "active",
      },
      set,
      _meta: {
        action_kind: rec.action,
        embed_required: contentChanged,
        reason: rec.reason,
        verified_source: rec.verified_source,
        merge_into_live_id: rec.merge_into_live_id ?? null,
      },
    });
  }

  // ── Inserts (additions + reference-only) ───────────────────────────────────
  const insertRecs = [
    ...additions.map((r) => ({ ...r, _src: "active_additions" })),
    ...referenceOnly.map((r) => ({ ...r, _src: "reference_only" })),
  ];

  // Dedup index seeded from live rows, then extended as inserts are accepted.
  const takenKeys = new Map();
  const takenPrimaryTitles = new Set(liveRows.map((r) => normalizeTitle(r.title)));
  for (const r of liveRows) {
    for (const k of dedupKeys(r)) if (!takenKeys.has(k)) takenKeys.set(k, `live:${r.title}`);
  }
  // Also index what the existing-row updates will SET, so an insert cannot
  // collide with a corrected record's new identity.
  for (const a of actions) {
    for (const k of dedupKeys(a.set)) if (!takenKeys.has(k)) takenKeys.set(k, `updated:${a.label}`);
    if (a.set.title) takenPrimaryTitles.add(normalizeTitle(a.set.title));
  }

  for (const rec of insertRecs) {
    const set = { ...(rec.set ?? {}) };
    const label = `INSERT "${set.title ?? rec.key}"`;
    validateSet(set, { isInsert: true, label, errors });

    const identityKeys = dedupKeys(set).filter((key) => !key.startsWith("title:"));
    const matches = liveRows.filter((row) =>
      normalizeTitle(row.title) === normalizeTitle(set.title)
      || dedupKeys(row).some((key) => identityKeys.includes(key))
    );
    if (matches.length) {
      const previouslyClaimed = matches.some((row) => seenIds.has(row.id));
      for (const row of matches) seenIds.add(row.id);
      if (matches.length !== 1 || previouslyClaimed) {
        errors.push(`${label}: duplicate ${identityKeys.join(" / ")} or title overlaps another catalogue record`);
      } else {
        const row = matches[0];
        const chain = revById.get(row.id);
        if (chain) {
          chain.consumed = true;
          // Additions are matched by identity; a revision that rewrote identity
          // would stop matching after apply and be re-inserted as a duplicate.
          const identityEdits = IDENTITY_FIELDS.filter((k) => chain.revs.some((r) => Object.hasOwn(r.set, k)));
          if (identityEdits.length) {
            errors.push(`${label}: revisions may not change an addition's identity (${identityEdits.join(", ")}) — supersede it instead`);
            continue;
          }
          const r = resolveRevisionChain(row, set, chain);
          if (r.state === "applied") { unchanged++; continue; }
          if (r.state === "error") { errors.push(`${label}: ${r.message}`); continue; }
          const contentChanged = r.set.content != null && r.set.content !== row.content;
          actions.push({
            op: "update", label: `REVISION ${label}`, id: row.id,
            expect: { title: row.title, content_md5: md5(row.content), status: row.status ?? "active" },
            set: r.set,
            _meta: { action_kind: "REVISION", embed_required: contentChanged,
                     reason: chain.revs.map((x) => x.reason).filter(Boolean).join(" | "),
                     verified_source: chain.revs.map((x) => x.verified_source).filter(Boolean).join(" | ") },
          });
          continue;
        }
        const differences = changedFields(row, set);
        if (differences.length) {
          errors.push(`${label}: existing addition diverges from the reviewed catalogue (${differences.join(", ")})`);
        } else {
          unchanged++;
        }
      }
      continue;
    }

    const titleKey = normalizeTitle(set.title);
    if (titleKey && takenPrimaryTitles.has(titleKey)) {
      errors.push(`${label}: title collides with another live or planned record`);
      continue;
    }

    let collided = false;
    for (const k of dedupKeys(set)) {
      if (takenKeys.has(k)) {
        // A shared alias is a warning; a shared canonical id or URL is an error.
        if (k.startsWith("canonical:") || k.startsWith("url:")) {
          errors.push(`${label}: duplicate ${k} — already claimed by ${takenKeys.get(k)}`);
          collided = true;
        } else {
          warnings.push(`${label}: shares alias/title key ${k} with ${takenKeys.get(k)}`);
        }
      }
    }
    if (collided) continue;
    takenPrimaryTitles.add(titleKey);
    for (const k of dedupKeys(set)) if (!takenKeys.has(k)) takenKeys.set(k, label);

    actions.push({
      op: "insert",
      label,
      set,
      _meta: {
        action_kind: "INSERT",
        embed_required: true, // every insert needs a fresh vector
        catalogue: rec._src,
        verified_source: rec.verified_source,
      },
    });
  }

  for (const r of liveRows) {
    if (!seenIds.has(r.id)) {
      errors.push(`live row ${r.id} "${r.title}" has no disposition in the catalogue`);
    }
  }

  for (const [liveId, chain] of revById) {
    if (!chain.consumed) errors.push(`REVISION ${liveId}: targets a row with no catalogue disposition`);
  }

  // Display policy: only peer-reviewed sources whose venue was verified on the
  // publisher's own site may be active (and so shown or retrieved). Checked on
  // the RESULTING state, so a plan cannot make an unreviewed source active and
  // a stale catalogue cannot keep one active.
  if (requirePeerReviewed) {
    const pending = new Map(actions.filter((a) => a.op === "update").map((a) => [a.id, a.set]));
    const resulting = [
      ...liveRows.map((r) => ({ ...r, ...(pending.get(r.id) ?? {}) })),
      ...actions.filter((a) => a.op === "insert").map((a) => a.set),
    ];
    for (const r of resulting) {
      if ((r.status ?? "active") === "active" && r.evidence_status !== "peer_reviewed") {
        errors.push(`policy: active record "${r.title}" is ${r.evidence_status ?? "unclassified"} — only peer-reviewed, venue-verified sources may be active`);
      }
    }
  }

  const stats = {
    live_rows: liveRows.length,
    updates: actions.filter((a) => a.op === "update").length,
    inserts: actions.filter((a) => a.op === "insert").length,
    embeddings_required: actions.filter((a) => a._meta.embed_required).length,
    unchanged,
    physical_after: liveRows.length + actions.filter((a) => a.op === "insert").length,
  };

  return { actions, errors, warnings, stats };
}

/**
 * Final gate before the plan is handed to the database. Checks invariants that
 * only hold once every action is known.
 */
export function validatePlan(plan, { liveRows = [] } = {}) {
  const errors = [...plan.errors];

  for (const a of plan.actions) {
    if (a._meta.embed_required && !Array.isArray(a.embedding)) {
      errors.push(`${a.label}: embed_required but no embedding attached`);
    }
    if (!a._meta.embed_required && Array.isArray(a.embedding)) {
      errors.push(`${a.label}: embedding attached but no content change — would overwrite a valid vector`);
    }
    if (Array.isArray(a.embedding)) {
      if (a.embedding.length !== EMBEDDING_DIM) {
        errors.push(`${a.label}: embedding has ${a.embedding.length} dims, expected ${EMBEDDING_DIM}`);
      } else if (!a.embedding.every((n) => Number.isFinite(n))) {
        errors.push(`${a.label}: embedding contains non-finite values`);
      }
    }
    if (a.op === "update" && !a.expect?.content_md5) {
      errors.push(`${a.label}: update without an expect.content_md5 guard`);
    }
  }

  // Resulting active set must have unique canonical identifiers.
  const activeCanon = new Map();
  const resulting = [];
  const updatedIds = new Set(plan.actions.filter((a) => a.op === "update").map((a) => a.id));
  for (const r of liveRows) if (!updatedIds.has(r.id)) resulting.push(r);
  for (const a of plan.actions) {
    const base = a.op === "update" ? (liveRows.find((r) => r.id === a.id) ?? {}) : {};
    resulting.push({ ...base, ...a.set });
  }
  for (const r of resulting) {
    if ((r.status ?? "active") !== "active") continue;
    const cid = normalizeCanonicalId(r.canonical_id);
    if (!cid) continue;
    if (activeCanon.has(cid)) {
      errors.push(`two ACTIVE records share canonical id ${cid}: "${activeCanon.get(cid)}" and "${r.title}"`);
    } else {
      activeCanon.set(cid, r.title);
    }
  }

  const activeCount = resulting.filter((r) => (r.status ?? "active") === "active").length;
  const retrievableCount = resulting.filter(
    (r) => (r.status ?? "active") === "active" && r.retrieval_enabled !== false
  ).length;

  return {
    ok: errors.length === 0,
    errors,
    warnings: plan.warnings,
    reconciliation: {
      physical_before: liveRows.length,
      inserted: plan.stats.inserts,
      physical_deletions: 0, // archival-only policy: nothing is ever deleted
      physical_after: liveRows.length + plan.stats.inserts,
      active_after: activeCount,
      retrievable_after: retrievableCount,
    },
  };
}

/** Strips planner-only metadata, producing the exact payload the RPC expects. */
export function toRpcPayload(plan, { expectedRowCount }) {
  return {
    expected_row_count: expectedRowCount,
    actions: plan.actions.map(({ _meta, ...a }) => a),
  };
}
