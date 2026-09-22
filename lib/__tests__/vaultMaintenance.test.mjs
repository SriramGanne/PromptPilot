import test from "node:test";
import assert from "node:assert/strict";
import {
  digestRows, assertPlanMatches, reusableEmbeddings, embeddingSpec,
  hashValue, verifyAppliedPlan,
} from "../vaultMaintenance.mjs";

const vector = () => Array(1024).fill(0.0123456789);
const action = () => ({ op: "update", id: "one", label: "UPDATE one",
  expect: { title: "before" }, set: { title: "after", content: "new content", status: "active", retrieval_enabled: true, canonical_id: "arxiv:example" },
  _meta: { embed_required: true }, embedding: vector() });
const plan = () => ({ errors: [], actions: [action()] });

test("full-state digests ignore key/row order but cover all metadata and vector values", () => {
  const rows = [{ id: "b", title: "B", aliases: ["b"], metadata: { z: 2, a: 1 }, embedding: [0.3] }, { id: "a", title: "A" }];
  const reordered = [{ title: "A", id: "a" }, { embedding: "[0.3]", metadata: { a: 1, z: 2 }, aliases: ["b"], title: "B", id: "b" }];
  assert.equal(digestRows(rows), digestRows(reordered));
  for (const change of [{ aliases: ["changed"] }, { reviewed_at: "today" }, { publication_date: "2026-09-22" }, { embedding: [0.4] }]) {
    assert.notEqual(digestRows(rows), digestRows([{ ...rows[0], ...change }, rows[1]]));
  }
});

test("saved-plan validation detects changed catalogue fields and live guards", () => {
  const saved = plan();
  const current = plan();
  delete current.actions[0].embedding;
  assert.doesNotThrow(() => assertPlanMatches(saved, current));
  current.actions[0].set.merged_into = "target";
  assert.throws(() => assertPlanMatches(saved, current), /differs/);
  delete current.actions[0].set.merged_into;
  current.actions[0].expect.title = "changed live";
  assert.throws(() => assertPlanMatches(saved, current), /differs/);
});

test("embedding reuse requires model provenance and exact text", () => {
  const saved = { plan: plan(), embedding_spec: embeddingSpec() };
  const cache = reusableEmbeddings(saved);
  assert.ok(cache.has(hashValue({ text: "new content", ...embeddingSpec() })));
  assert.ok(!cache.has(hashValue({ text: "changed content", ...embeddingSpec() })));
  assert.throws(() => reusableEmbeddings({ ...saved, embedding_spec: { ...embeddingSpec(), model: "other" } }), /provenance/);
  delete saved.embedding_spec;
  assert.throws(() => reusableEmbeddings(saved), /provenance/);
  assert.equal(reusableEmbeddings(saved, { legacyModel: embeddingSpec().model }).size, 1);
});

test("post-state verifier accounts for pgvector float32 storage and unchanged fields", () => {
  const before = [{ id: "one", title: "before", content: "old", embedding: vector(), authors: "Author", created_at: "yesterday" }];
  const p = plan();
  const after = [{ ...before[0], ...p.actions[0].set, embedding: vector().map(Math.fround), reviewed_at: "today" }];
  const result = { updated: 1, inserted: 0, affected: [{ op: "update", label: "UPDATE one", id: "one" }] };
  assert.equal(verifyAppliedPlan(before, after, p, result).ok, true);
  after[0].authors = "Unexpected author";
  assert.match(verifyAppliedPlan(before, after, p, result).errors.join(" "), /untouched field authors/);
});

test("post-state verifier rejects unexpected additions and metadata-only embedding changes", () => {
  const before = [{ id: "one", title: "before", embedding: vector() }];
  const p = { actions: [{ op: "update", id: "one", label: "metadata", set: { title: "after" } }] };
  const result = { updated: 1, inserted: 0, affected: [{ op: "update", label: "metadata", id: "one" }] };
  const after = [{ ...before[0], title: "after", embedding: Array(1024).fill(0.2) }, { id: "unrelated" }];
  const check = verifyAppliedPlan(before, after, p, result);
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /metadata-only update changed embedding/);
  assert.match(check.errors.join(" "), /Unexpected post-apply UUID unrelated/);
});
