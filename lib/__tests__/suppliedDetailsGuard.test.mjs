import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSuppliedQuantities, ensureSuppliedQuantitiesInPrompt } from "../suppliedDetailsGuard.mjs";

test("Grok regression: a supplied member count replaces its default placeholder", () => {
  const intent = "Brainstorm six ways to organize a neighborhood tool library for 20 members with no budget.";
  const prompt = "### PROMPT START\nBrainstorm six ways for [NUMBER_OF_MEMBERS — default 20] members.\n### PROMPT END";
  assert.equal(hasSuppliedQuantities(intent), true);
  assert.equal(
    ensureSuppliedQuantitiesInPrompt(intent, prompt),
    "### PROMPT START\nBrainstorm six ways for 20 members.\n### PROMPT END"
  );
});

test("a supplied quantity wins over a wrong default and an unfilled slot", () => {
  const intent = "Plan lending for 20 members and 12 books.";
  const prompt = "### PROMPT START\nPlan for [MEMBER_COUNT — default 30] members and [NUMBER_OF_BOOKS] books.\n### PROMPT END";
  assert.equal(
    ensureSuppliedQuantitiesInPrompt(intent, prompt),
    "### PROMPT START\nPlan for 20 members and 12 books.\n### PROMPT END"
  );
});

test("common modifiers and hyphenated counts preserve the supplied unit", () => {
  const prompt = "### PROMPT START\nPlan for [NUMBER_OF_MEMBERS] members.\n### PROMPT END";
  assert.ok(ensureSuppliedQuantitiesInPrompt("Plan for 20 active members.", prompt).includes("20 members"));
  assert.ok(ensureSuppliedQuantitiesInPrompt("Plan for a 20-member group.", prompt).includes("20 members"));
});

test("unknown and ambiguous quantities remain placeholders", () => {
  const intent = "Plan for 20 members now and 30 members later.";
  const prompt = "### PROMPT START\nUse [NUMBER_OF_MEMBERS] members and [BUDGET] budget.\n### PROMPT END";
  assert.equal(ensureSuppliedQuantitiesInPrompt(intent, prompt), prompt);
  assert.equal(
    ensureSuppliedQuantitiesInPrompt("Plan a neighborhood tool library.", prompt),
    prompt
  );
  const prose = "### PROMPT START\n[Ask members to confirm] before lending.\n### PROMPT END";
  assert.equal(ensureSuppliedQuantitiesInPrompt("Plan for 20 members.", prose), prose);
  const literal = "### PROMPT START\nKeep [NUMBER_OF_MEMBERS] in the reusable template.\n### PROMPT END";
  assert.equal(ensureSuppliedQuantitiesInPrompt("Use [NUMBER_OF_MEMBERS] as a variable for a group of 20 members.", literal), literal);
});

test("literal source material is not edited", () => {
  const intent = "Summarize this note for 20 members.";
  const prompt = "### PROMPT START\nSummarize for [NUMBER_OF_MEMBERS] members.\n<source_material>\nThe note literally says [NUMBER_OF_MEMBERS].\n</source_material>\n### PROMPT END";
  const repaired = ensureSuppliedQuantitiesInPrompt(intent, prompt);
  assert.ok(repaired.includes("Summarize for 20 members."));
  assert.ok(repaired.includes("The note literally says [NUMBER_OF_MEMBERS]."));
  assert.equal(ensureSuppliedQuantitiesInPrompt(intent, repaired), repaired);
});
