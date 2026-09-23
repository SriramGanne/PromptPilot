import test from "node:test";
import assert from "node:assert/strict";
import { getCitedSources } from "../researchCitations.mjs";

const sources = [
  { title: "Paper A", similarity: 0.82, citation_url: "https://example.test/a" },
  { title: "Paper B", similarity: 0.71, citation_url: "https://example.test/b" },
];

test("only cited, supplied IDs appear with canonical paper metadata", () => {
  const output = `<thinking>Draft</thinking>\n<context_grounding>\n[2] Uses a clear delimiter for source data.\n[1] Adds explicit output constraints.\n</context_grounding>\n### PROMPT START\nDo the task.\n### PROMPT END`;
  assert.deepEqual(getCitedSources(output, sources), [
    { id: 2, title: "Paper B", similarity: 0.71, citation_url: "https://example.test/b", reason: "Uses a clear delimiter for source data." },
    { id: 1, title: "Paper A", similarity: 0.82, citation_url: "https://example.test/a", reason: "Adds explicit output constraints." },
  ]);
});

test("unknown IDs, duplicates, and empty explanations are not shown", () => {
  const output = `<context_grounding>\n[3] A claimed paper that was never supplied.\n[1] Adds explicit output constraints.\n[1] A duplicate claim with other wording.\n[2] none\n</context_grounding>`;
  assert.deepEqual(getCitedSources(output, sources).map((source) => source.id), [1]);
});

test("missing or malformed grounding never falls back to supplied papers", () => {
  assert.deepEqual(getCitedSources("### PROMPT START\nPrompt", sources), []);
  assert.deepEqual(getCitedSources("<context_grounding>[1] Paper A</context_grounding>", sources), []);
  assert.deepEqual(getCitedSources("<context_grounding>none</context_grounding>", sources), []);
});

test("final version citations replace initial-draft citations", () => {
  const initial = "<context_grounding>\n[1] Adds explicit output constraints.\n</context_grounding>";
  const revised = "<context_grounding>\n[2] Uses a clear delimiter for source data.\n</context_grounding>";
  assert.deepEqual(getCitedSources(initial, sources).map((source) => source.id), [1]);
  assert.deepEqual(getCitedSources(revised, sources).map((source) => source.id), [2]);
});
