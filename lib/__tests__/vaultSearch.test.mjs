import test from "node:test";
import assert from "node:assert/strict";
import { retrieveHybridResearch } from "../vaultSearch.mjs";
import { getActiveResearchRecords, getTechniqueVocabulary, vocabularyFromRows, buildRetrievalQuerySystem } from "../vaultTaxonomy.mjs";

function record(index, overrides = {}) {
  return {
    id: `record-${String(index).padStart(4, "0")}`,
    title: `Research Method ${index}`,
    content: "A general prompt optimization method with model evaluation.",
    summary: "General optimizer guidance",
    best_for: "Improving prompts",
    aliases: [],
    category: "Optimization",
    citation_url: `https://example.test/paper/${index}`,
    status: "active",
    retrieval_enabled: true,
    ...overrides,
  };
}

// Exercise the actual modules via their injected Supabase interface. The fake
// implements lifecycle filtering, ordered pagination and a fresh RPC view;
// metadata caches can therefore be stale while the RPC is current.
function fakeVault(initialRows, initialScores = {}) {
  const state = {
    rows: structuredClone(initialRows),
    scores: { ...initialScores },
    reads: [],
    rpcCalls: [],
    readError: null,
    rpcError: null,
    failPage: null,
  };
  const client = {
    from(table) {
      const call = { table, filters: [] };
      const builder = {
        select(columns) { call.columns = columns; return builder; },
        eq(column, value) { call.filters.push([column, value]); return builder; },
        order(column, options) { call.order = [column, options]; return builder; },
        async range(start, end) {
          call.range = [start, end];
          state.reads.push(call);
          if (state.readError || state.failPage === start) return { data: null, error: { message: state.readError ?? "page unavailable" } };
          const filtered = state.rows.filter((row) => call.filters.every(([key, value]) => row[key] === value));
          filtered.sort((a, b) => a.id.localeCompare(b.id));
          return { data: structuredClone(filtered.slice(start, end + 1)), error: null };
        },
      };
      return builder;
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      if (state.rpcError) return { data: null, error: { message: state.rpcError } };
      const data = state.rows
        .filter((row) => row.status === "active" && row.retrieval_enabled === true)
        .map((row) => ({ id: row.id, title: row.title, content: row.content, category: row.category, similarity: state.scores[row.id] ?? 0.7 }))
        .filter((row) => row.similarity > args.match_threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, args.match_count);
      return { data, error: null };
    },
  };
  return { state, client };
}

test("vault search: scores the complete corpus before lexical ranking, not semantic top twelve", async () => {
  const rows = Array.from({ length: 35 }, (_, index) => record(index));
  rows[34] = record(34, { title: "Distinctive Stability Method", aliases: ["STAB35"], content: "Preserves successful examples against optimizer drift." });
  const { client, state } = fakeVault(rows, { [rows[34].id]: 0.05 });
  const result = await retrieveHybridResearch(client, [1, 0], { query: "Use STAB35 for prompt optimization.", matchThreshold: 0.25 });
  assert.equal(result[0].id, rows[34].id);
  assert.equal(result[0].similarity, 0.05, "raw cosine is preserved despite lexical promotion");
  assert.equal(result[0].nameMatch, true);
  assert.equal(state.rpcCalls[0].name, "match_prompt_research");
  assert.ok(state.rpcCalls[0].args.match_count >= 35);
  assert.ok(state.rpcCalls[0].args.match_threshold < -1, "the semantic floor cannot discard lexical candidates");
  assert.deepEqual(state.rpcCalls[0].args.query_embedding, [1, 0]);
});

test("vault search: original query retrieves a low-cosine mechanism without a method-name shortcut", async () => {
  const rows = Array.from({ length: 35 }, (_, index) => record(index));
  rows[34] = record(34, {
    content: "Preserve successful examples to prevent optimizer drift and oscillation.",
    summary: "Protect working examples against regression",
    best_for: "Optimizer drift and oscillation",
  });
  const scores = Object.fromEntries(rows.map((row) => [row.id, 0.65]));
  scores[rows[34].id] = 0.20;
  const { client } = fakeVault(rows, scores);
  const result = await retrieveHybridResearch(client, [1, 0], {
    query: "Preserve successful examples against optimizer drift and oscillation.",
    matchThreshold: 0.25,
  });
  assert.ok(result.some((row) => row.id === rows[34].id));
  assert.equal(result.find((row) => row.id === rows[34].id).nameMatch, false);
});

test("vault search: fresh RPC lifecycle exclusion overrides cached active metadata", async () => {
  const rows = [record(0, { aliases: ["RETIRED"] }), record(1)];
  const { client, state } = fakeVault(rows);
  await getActiveResearchRecords(client);
  state.rows[0].status = "archived";
  state.rows[0].retrieval_enabled = false;
  const result = await retrieveHybridResearch(client, [1], { query: "RETIRED" });
  assert.equal(state.reads.length, 1, "test actually exercises the stale metadata cache");
  assert.ok(result.every((row) => row.id !== rows[0].id));
});

test("vault search: a newly inserted RPC ID refreshes metadata inside the cache TTL", async () => {
  const { client, state } = fakeVault([record(0)]);
  await getActiveResearchRecords(client);
  const added = record(1, { title: "Newly Added Technique", aliases: ["ADDED2"], citation_url: "https://example.test/new-source" });
  state.rows.push(added);
  state.scores[added.id] = 0.02;
  const result = await retrieveHybridResearch(client, [1], { query: "Use ADDED2." });
  assert.equal(state.reads.length, 2);
  assert.equal(result[0].id, added.id);
  assert.equal(result[0].citation_url, added.citation_url);
  assert.equal(result[0].nameMatch, true);
});

test("vault search: metadata, RPC and refresh errors fail closed without catalogue fallback", async () => {
  const first = fakeVault([record(0)]);
  first.state.readError = "database unavailable";
  await assert.rejects(retrieveHybridResearch(first.client, [1], { query: "TRAS" }), /Active vault read failed: database unavailable/);
  await assert.rejects(getTechniqueVocabulary(first.client), /Active vault read failed/);
  assert.equal(first.state.rpcCalls.length, 0);

  const second = fakeVault([record(0)]);
  second.state.rpcError = "RPC unavailable";
  await assert.rejects(retrieveHybridResearch(second.client, [1], { query: "TRAS" }), /Semantic vault read failed: RPC unavailable/);

  const third = fakeVault([record(0)]);
  await getActiveResearchRecords(third.client);
  third.state.rows.push(record(1));
  third.state.readError = "refresh unavailable";
  await assert.rejects(retrieveHybridResearch(third.client, [1], { query: "TRAS" }), /Active vault read failed: refresh unavailable/);
});

test("vault search: metadata preserves source citation and raw cosine through the RPC join", async () => {
  const source = record(0, { aliases: ["SOURCE1"], citation_url: "https://aclanthology.org/2024.findings-acl.21/" });
  const { client } = fakeVault([source], { [source.id]: 0.63 });
  const [result] = await retrieveHybridResearch(client, [1], { query: "SOURCE1" });
  assert.equal(result.citation_url, source.citation_url);
  assert.equal(result.similarity, 0.63);
  assert.deepEqual(result.aliases, ["SOURCE1"]);
  assert.equal(result.status, "active");
  assert.equal(result.retrieval_enabled, true);
  assert.ok(Number.isFinite(result.hybridScore));
});

test("vault taxonomy: vocabulary includes every active record beyond the old forty-term cap", async () => {
  const rows = Array.from({ length: 65 }, (_, index) => record(index, { aliases: [`METHOD${index}`] }));
  rows.push(record(100, { title: "Retired Source", status: "archived", retrieval_enabled: false }));
  rows.push(record(101, { title: "Disabled Source", retrieval_enabled: false }));
  const { client } = fakeVault(rows);
  const terms = await getTechniqueVocabulary(client);
  assert.equal(terms.length, 65);
  for (let index = 0; index < 65; index++) assert.ok(terms.includes(`Research Method ${index} (METHOD${index})`));
  assert.ok(terms.every((term) => !term.includes("Retired") && !term.includes("Disabled")));
  const prompt = buildRetrievalQuerySystem(terms);
  assert.ok(prompt.includes("METHOD64"));
  assert.ok(!prompt.includes("Retired Source"));
});

test("vault taxonomy: stable pagination collects every active row without embedding downloads", async () => {
  const rows = Array.from({ length: 1003 }, (_, index) => record(index));
  rows.push(record(2000, { status: "archived", retrieval_enabled: false }));
  const { client, state } = fakeVault(rows);
  const result = await getActiveResearchRecords(client);
  assert.equal(result.length, 1003);
  assert.equal(new Set(result.map((row) => row.id)).size, 1003);
  assert.deepEqual(state.reads.map((read) => read.range), [[0, 499], [500, 999], [1000, 1499]]);
  for (const read of state.reads) {
    assert.equal(read.table, "prompt_research");
    assert.deepEqual(read.filters, [["status", "active"], ["retrieval_enabled", true]]);
    assert.deepEqual(read.order, ["id", { ascending: true }]);
    assert.ok(!read.columns.split(",").includes("embedding"));
    assert.ok(read.columns.split(",").includes("citation_url"));
  }
  await getActiveResearchRecords(client);
  assert.equal(state.reads.length, 3, "unchanged reads use the short metadata cache");
});

test("vault taxonomy: a later-page read failure does not cache partial rows", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => record(index));
  const { client, state } = fakeVault(rows);
  state.failPage = 500;
  await assert.rejects(getActiveResearchRecords(client), /page unavailable/);
  state.failPage = null;
  const result = await getActiveResearchRecords(client);
  assert.equal(result.length, 501);
  assert.deepEqual(state.reads.map((read) => read.range[0]), [0, 500, 0, 500]);
});

test("vault taxonomy: cached metadata is isolated by client and explicit refresh works", async () => {
  const first = fakeVault([record(0)]);
  const second = fakeVault([record(1)]);
  assert.equal((await getActiveResearchRecords(first.client))[0].id, "record-0000");
  assert.equal((await getActiveResearchRecords(second.client))[0].id, "record-0001");
  first.state.rows = [record(2)];
  assert.equal((await getActiveResearchRecords(first.client))[0].id, "record-0000");
  assert.equal((await getActiveResearchRecords(first.client, { forceRefresh: true }))[0].id, "record-0002");
});

test("vault taxonomy: direct vocabulary conversion filters lifecycle and avoids duplicate aliases", () => {
  const rows = [
    record(0, { title: "Method Alpha (ALPHA)", aliases: ["ALPHA"] }),
    record(1, { title: "Retired", status: "merged", retrieval_enabled: false }),
    record(2, { title: "Not Yet Reviewed", status: "watch" }),
  ];
  assert.deepEqual(vocabularyFromRows(rows), ["Method Alpha"]);
});
