import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rankHybridResearch, tokenizeResearchQuery } from "../vaultRetrieval.mjs";

// Use every reviewed card, including retired records, so IDF and lifecycle
// behavior reflect the real 35-card active corpus rather than a toy shortlist.
const corpus = ["active_existing", "active_additions"].flatMap((file) => {
  const catalogue = JSON.parse(readFileSync(new URL(`../../data/vault/${file}.json`, import.meta.url), "utf8"));
  return catalogue.records.map((record) => ({ id: record.live_id ?? record.key, ...record.set }));
});
const withScores = (scores = {}) => corpus.map((row) => ({ ...row, similarity: scores[row.id] ?? 0.70 }));
const ids = (rows) => rows.map((row) => row.id);

test("hybrid: folds English inflections without method-specific keyword rules", () => {
  assert.deepEqual(tokenizeResearchQuery("drift drifting drifts"), ["drift", "drift", "drift"]);
  assert.deepEqual(tokenizeResearchQuery("failure failures"), ["failur", "failur"]);
  assert.deepEqual(tokenizeResearchQuery("optimize optimiser optimization"), ["optimiz", "optimiz", "optimiz"]);
  assert.deepEqual(tokenizeResearchQuery("attribute attribution"), ["attribut", "attribut"]);
  assert.deepEqual(tokenizeResearchQuery("GMPO multi-judge judges"), ["gmpo", "multi", "judg", "judg"]);
});

test("hybrid: recovers TRAS outside the semantic top seven without changing raw cosine", () => {
  const rows = withScores({ tras: 0.638, pe2: 0.738 });
  assert.ok(rows.filter((row) => row.status === "active" && row.similarity > 0.638).length > 7);
  const out = rankHybridResearch(rows, { query: "Prevent an automatic prompt optimizer from drifting away from the task." });
  assert.equal(out[0].id, "tras");
  assert.equal(out[0].similarity, 0.638);
  assert.equal(out.find((row) => row.id === "pe2").similarity, 0.738);
  assert.ok(out[0].hybridScore > out[1].hybridScore);
});

test("hybrid: stable mechanism selection under semantic near-tie variance", () => {
  const queries = [
    ["Prevent an automatic prompt optimizer from drifting away from the task.", "tras"],
    ["Preserve successful examples so optimizer edits do not regress or oscillate.", "tras"],
    ["Attribute failures to prompt segments and use several judges.", "gmpo"],
    ["Optimize prompt quality, model choice, cost and latency together.", "coral"],
    ["Optimize instructions and examples across a multi-stage language-model program.", "mipro"],
    ["Use prompt structure as a searchable program.", "sammo"],
    ["Optimize a prompt using textual feedback.", "textgrad"],
  ];
  for (const [query, expected] of queries) {
    for (let sample = 0; sample < 10; sample++) {
      // Controlled near-tie perturbations model changes in a HyDE embedding.
      // The lexical query is always the user's unchanged original intent.
      const rows = corpus.map((row, index) => ({
        ...row,
        similarity: row.id === expected ? 0.63 : 0.64 + ((index * 13 + sample * 7) % 15) / 100,
      }));
      const out = rankHybridResearch(rows, { query });
      assert.ok(ids(out).includes(expected), `${expected} missed for sample ${sample}: ${ids(out)}`);
    }
  }
});

test("hybrid: distinguishes nearby optimizer mechanisms within one category", () => {
  const rows = withScores({ tras: 0.64, gmpo: 0.64, pe2: 0.75, pmpo: 0.76 });
  assert.equal(rankHybridResearch(rows, { query: "Attribute failures to prompt segments and use several judges." })[0].id, "gmpo");
  assert.equal(rankHybridResearch(rows, { query: "Prevent optimizer drift by preserving successful examples." })[0].id, "tras");
  assert.equal(rankHybridResearch(rows, { query: "Optimize the optimizer's meta-prompt with context specification and a detailed task description." })[0].id, "pe2");
});

test("hybrid: lexical scoring is independent of technique names and card IDs", () => {
  const source = withScores({ tras: 0.638, pe2: 0.738 });
  const anonymous = source.map((row, index) => ({ ...row, id: `opaque-${index}`, title: "Research record", aliases: [] }));
  const query = "Prevent optimizer drift by preserving successful examples.";
  const expected = anonymous[source.findIndex((row) => row.id === "tras")].id;
  assert.equal(rankHybridResearch(anonymous, { query })[0].id, expected);
});

test("hybrid: exact alias can rescue a candidate below the semantic threshold", () => {
  const rows = withScores({ mipro: 0 });
  const out = rankHybridResearch(rows, { query: "Use MIPROv2 for this program.", matchThreshold: 0.75 });
  assert.equal(out[0].id, "mipro");
  assert.equal(out[0].similarity, 0);
  assert.equal(out[0].nameMatch, true);
});

test("hybrid: strong mechanism evidence can survive a semantic threshold", () => {
  const out = rankHybridResearch(withScores({ tras: 0.10 }), {
    query: "Preserve successful examples against optimizer drift and oscillation.",
    matchThreshold: 0.8,
  });
  assert.ok(ids(out).includes("tras"));
});

test("hybrid: a lone common lexical term cannot bypass the semantic threshold", () => {
  const rows = withScores(Object.fromEntries(corpus.map((row) => [row.id, 0])));
  assert.deepEqual(rankHybridResearch(rows, { query: "prompt", matchThreshold: 0.25 }), []);
  assert.deepEqual(rankHybridResearch(rows, { query: "unrelatedxyz", matchThreshold: 0.25 }), []);
});

test("hybrid: exact-name matches require token boundaries and unique identity", () => {
  const rows = [
    { id: "one", status: "active", retrieval_enabled: true, title: "One Research Method", aliases: ["TRAS"], content: "stability", similarity: 0 },
    { id: "two", status: "active", retrieval_enabled: true, title: "Two Research Method", aliases: ["TRAS"], content: "programs", similarity: 0 },
  ];
  assert.deepEqual(rankHybridResearch(rows.slice(0, 1), { query: "contrast" }), []);
  assert.deepEqual(rankHybridResearch(rows, { query: "TRAS" }), []);
  assert.equal(rankHybridResearch(rows.slice(0, 1), { query: "TRAS" })[0].nameMatch, true);
});

test("hybrid: excluded lifecycle records never rank, even with perfect evidence", () => {
  const excluded = ["archived", "merged", "reference_only", "watch", "superseded"]
    .map((status) => ({ id: status, status, retrieval_enabled: true, title: "TRAS", aliases: ["TRAS"], content: "optimizer drift", similarity: 1 }));
  excluded.push(
    { id: "disabled", status: "active", retrieval_enabled: false, title: "TRAS", similarity: 1 },
    { id: "missing-lifecycle", title: "TRAS", similarity: 1 },
    { id: "missing-enabled", status: "active", title: "TRAS", similarity: 1 },
  );
  const out = rankHybridResearch([...withScores(), ...excluded], { query: "TRAS", limit: 100 });
  assert.ok(ids(out).includes("tras"));
  assert.ok(out.every((row) => row.status === "active" && row.retrieval_enabled === true));
  assert.ok(excluded.every((row) => !ids(out).includes(row.id)));
});

test("hybrid: mixed-case method aliases do not create ordinary-word identity boosts", () => {
  const row = { id: "method", status: "active", retrieval_enabled: true, title: "Reasoning and Acting", aliases: ["ReAct"], content: "tool use", similarity: 0 };
  assert.deepEqual(rankHybridResearch([row], { query: "Build a React interface" }), []);
  assert.deepEqual(rankHybridResearch([row], { query: "How should we react?" }), []);
  assert.equal(rankHybridResearch([row], { query: "Use ReAct" })[0].nameMatch, true);
});

test("hybrid: empty or unmatched lexical query retains semantic ordering", () => {
  const rows = withScores({ tras: 0.90, gmpo: 0.80, pe2: 0.75 });
  assert.equal(rankHybridResearch(rows, { query: "unrelatedxyz" })[0].id, "tras");
  assert.equal(rankHybridResearch(rows, { query: "" })[0].id, "tras");
  assert.deepEqual(rankHybridResearch([], { query: "TRAS" }), []);
  assert.deepEqual(rankHybridResearch(null), []);
  assert.deepEqual(rankHybridResearch(rows, { limit: 0 }), []);
});

test("hybrid: deterministic tie-breaking and input immutability", () => {
  const rows = withScores();
  const snapshot = structuredClone(rows);
  const query = "Optimize a prompt using textual feedback.";
  assert.deepEqual(ids(rankHybridResearch(rows, { query })), ids(rankHybridResearch([...rows].reverse(), { query })));
  assert.deepEqual(rows, snapshot);
});

test("hybrid: malformed semantic values cannot poison ranking", () => {
  const rows = withScores({ tras: Number.NaN, pe2: Infinity });
  const out = rankHybridResearch(rows, { query: "TRAS" });
  assert.equal(out[0].id, "tras");
  assert.ok(out.every((row) => Number.isFinite(row.hybridScore) && Number.isFinite(row.lexicalScore)));
});
