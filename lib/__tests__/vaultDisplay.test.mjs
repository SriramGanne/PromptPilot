import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchVaultEntries,
  getVaultCategories,
  countVaultCategories,
  filterVaultEntries,
  categoryForEntry,
} from "../vaultDisplay.mjs";

const catalogue = ["active_existing", "active_additions", "reference_only"].flatMap((file) => {
  const data = JSON.parse(readFileSync(new URL(`../../data/vault/${file}.json`, import.meta.url), "utf8"));
  return data.records.map((record) => ({ id: record.live_id ?? record.key, ...record.set }));
});
const active = catalogue.filter((row) => row.status === "active" && row.retrieval_enabled === true);

function fakeVault(rows, { failureAt = null } = {}) {
  const calls = [];
  const client = {
    from(table) {
      const call = { table, filters: [], orders: [] };
      const builder = {
        select(columns) { call.columns = columns; return builder; },
        eq(column, value) { call.filters.push([column, value]); return builder; },
        order(column, options) { call.orders.push([column, options]); return builder; },
        async range(start, end) {
          call.range = [start, end];
          calls.push(call);
          if (start === failureAt) return { data: null, error: { message: "vault read denied" } };
          const result = rows.filter((row) => call.filters.every(([field, value]) => row[field] === value));
          const fields = call.columns.split(",").map((field) => field.trim());
          const data = result.slice(start, end + 1).map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
          return { data: structuredClone(data), error: null };
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

test("vault display: all 35 active cards display instead of only 19 featured cards", async () => {
  assert.equal(active.length, 35, "curated regression fixture has 35 active cards");
  assert.equal(active.filter((row) => row.is_featured).length, 19, "old featured filter explains the production count");
  const { client, calls } = fakeVault(catalogue);
  const entries = await fetchVaultEntries(client);
  assert.equal(entries.length, 35);
  assert.deepEqual(new Set(entries.map((row) => row.id)), new Set(active.map((row) => row.id)));
  const notFeaturedIds = new Set(active.filter((row) => !row.is_featured).map((row) => row.id));
  assert.equal(entries.filter((row) => notFeaturedIds.has(row.id)).length, 16);
  for (const call of calls) {
    assert.equal(call.table, "prompt_research");
    assert.ok(call.filters.some(([field, value]) => field === "status" && value === "active"));
    assert.ok(call.filters.some(([field, value]) => field === "retrieval_enabled" && value === true));
    assert.ok(call.filters.every(([field]) => field !== "is_featured"));
  }
});

test("vault display: archived, merged, reference-only and disabled cards stay excluded", async () => {
  const disabled = { ...active[0], id: "disabled-active", retrieval_enabled: false };
  const { client } = fakeVault([...catalogue, disabled]);
  const entries = await fetchVaultEntries(client);
  assert.equal(entries.length, 35);
  assert.ok(entries.every((row) => row.status === "active" && row.retrieval_enabled === true));
  assert.ok(!entries.some((row) => row.id === "disabled-active"));
  for (const row of catalogue.filter((row) => row.status !== "active")) {
    assert.ok(!entries.some((entry) => entry.id === row.id), `${row.title} leaked into the visible vault`);
  }
});

test("vault display: paginated fetch includes cards after the first 500", async () => {
  const rows = Array.from({ length: 1003 }, (_, index) => ({ ...active[index % active.length], id: `entry-${index}` }));
  const { client, calls } = fakeVault(rows);
  const entries = await fetchVaultEntries(client);
  assert.equal(entries.length, 1003);
  assert.equal(new Set(entries.map((row) => row.id)).size, 1003);
  assert.deepEqual(calls.map((call) => call.range), [[0, 499], [500, 999], [1000, 1499]]);
  assert.ok(calls.every((call) => call.orders.length > 0), "pagination must use a stable order");
});

test("vault display: query errors propagate and partial pages are not returned as success", async () => {
  const firstPage = fakeVault(catalogue, { failureAt: 0 });
  await assert.rejects(fetchVaultEntries(firstPage.client), /vault read denied/);
  const rows = Array.from({ length: 501 }, (_, index) => ({ ...active[0], id: `entry-${index}` }));
  const secondPage = fakeVault(rows, { failureAt: 500 });
  await assert.rejects(fetchVaultEntries(secondPage.client), /vault read denied/);
  assert.deepEqual(secondPage.calls.map((call) => call.range[0]), [0, 500]);
});

test("vault display: dynamic categories and counts cover every active card", () => {
  const categories = getVaultCategories(active);
  const counts = countVaultCategories(active);
  assert.equal(categories[0], "All");
  assert.equal(new Set(categories).size, categories.length);
  assert.deepEqual(new Set(categories.slice(1)), new Set(active.map((row) => row.category)));
  assert.equal(counts.All, 35);
  assert.equal(counts.Optimization, 15);
  assert.equal(counts.Evaluation, 1);
  assert.equal(counts.Agentic, 3);
  assert.equal(counts.Retrieval, 1);
  assert.equal(Object.entries(counts).filter(([category]) => category !== "All").reduce((sum, [, count]) => sum + count, 0), 35);
  for (const category of categories.slice(1)) {
    assert.equal(filterVaultEntries(active, { category }).length, counts[category]);
  }
});

test("vault display: new categories and uncategorized cards remain reachable", () => {
  const rows = [
    { id: "new", title: "New Method", category: "New Research Family" },
    { id: "missing", title: "Missing category" },
    { id: "null", title: "Null category", category: null },
    { id: "blank", title: "Blank category", category: "  " },
  ];
  const categories = getVaultCategories(rows);
  assert.equal(categories[0], "All");
  assert.ok(categories.includes("New Research Family"));
  assert.ok(categories.includes("Uncategorized"));
  assert.equal(categoryForEntry(rows[0]), "New Research Family");
  for (const row of rows.slice(1)) assert.equal(categoryForEntry(row), "Uncategorized");
  assert.deepEqual(countVaultCategories(rows), { All: 4, "New Research Family": 1, Uncategorized: 3 });
  assert.equal(filterVaultEntries(rows, { category: "New Research Family" })[0].id, "new");
  assert.equal(filterVaultEntries(rows, { category: "Uncategorized" }).length, 3);
});

test("vault display: alias search is case-insensitive and combined category filters intersect", () => {
  const mipro = active.find((row) => row.id === "mipro");
  assert.ok(mipro.aliases.includes("MIPROv2"));
  assert.ok(!mipro.title.toLowerCase().includes("miprov2"), "fixture query tests an alias rather than a title substring");
  const found = filterVaultEntries(active, { query: "mIpRoV2" });
  assert.deepEqual(found.map((row) => row.id), ["mipro"]);
  assert.deepEqual(filterVaultEntries(active, { query: "mIpRoV2", category: "Optimization" }).map((row) => row.id), ["mipro"]);
  assert.deepEqual(filterVaultEntries(active, { query: "mIpRoV2", category: "Reasoning" }), []);
});

test("vault display: search covers visible summary and use-case text", () => {
  const rows = [{ id: "one", title: "Plain title", summary: "Rare summary phrase", best_for: "Distinctive use case", category: "Optimization", aliases: [] }];
  assert.equal(filterVaultEntries(rows, { query: "rare SUMMARY" })[0].id, "one");
  assert.equal(filterVaultEntries(rows, { query: "distinctive USE CASE" })[0].id, "one");
  assert.deepEqual(filterVaultEntries(rows, { query: "absentword" }), []);
});

test("vault display: empty search and All show every entry without mutating input", () => {
  const snapshot = structuredClone(active);
  assert.equal(filterVaultEntries(active).length, 35);
  assert.equal(filterVaultEntries(active, { query: "   ", category: "All" }).length, 35);
  getVaultCategories(active);
  countVaultCategories(active);
  filterVaultEntries(active, { query: "prompt", category: "Optimization" });
  assert.deepEqual(active, snapshot);
  assert.deepEqual(getVaultCategories([]), ["All"]);
  assert.deepEqual(countVaultCategories([]), { All: 0 });
  assert.deepEqual(filterVaultEntries([]), []);
});
