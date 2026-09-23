import test from "node:test";
import assert from "node:assert/strict";
import { getCitedSources } from "../researchCitations.mjs";

// The refinement module creates its Together client at import time; these
// pure parser tests never send a request.
process.env.TOGETHER_API_KEY ||= "test-key";
const { parseRefinementResponse, replaceContextGrounding } = await import("../refinePrompt.js");

test("revised prompt citations replace draft grounding", () => {
  const output = `<refined_prompt>
You are a careful editor. Summarize the update in two short sections.
</refined_prompt>
<source_citations>
[2] The two-section structure uses the paper's decomposition technique.
[1] Its checks make unsupported claims easier to catch.
[2] Duplicate wording should not make a second citation.
</source_citations>`;
  const { body, citations } = parseRefinementResponse(output, 2);
  assert.equal(body, "You are a careful editor. Summarize the update in two short sections.");
  assert.deepEqual(citations, [
    "[2] The two-section structure uses the paper's decomposition technique.",
    "[1] Its checks make unsupported claims easier to catch.",
  ]);

  const before = `<thinking>Initial draft.</thinking>
<context_grounding>
[1] Old explanation for V1.
</context_grounding>
### PROMPT START`;
  const refined = `${replaceContextGrounding(before, citations)}\n${body}\n### PROMPT END`;
  assert.ok(refined.includes("[2] The two-section structure"));
  assert.ok(!refined.includes("Old explanation for V1"));
  assert.ok(refined.includes("### PROMPT START\n"));
});

test("missing or malformed V2 citations clear the draft's paper claims", () => {
  const before = `<context_grounding>\n[1] Draft citation.\n</context_grounding>\n### PROMPT START`;
  for (const output of [
    `<refined_prompt>Revised body.</refined_prompt>`,
    `<refined_prompt>Revised body.</refined_prompt><source_citations>[3] Unknown paper.</source_citations>`,
    `<refined_prompt>Revised body.</refined_prompt><source_citations>Paper 1 is helpful.</source_citations>`,
    `<refined_prompt>Revised body.</refined_prompt><source_citations>none</source_citations>`,
  ]) {
    const parsed = parseRefinementResponse(output, 2);
    assert.equal(parsed.body, "Revised body.");
    assert.deepEqual(parsed.citations, []);
    const grounded = replaceContextGrounding(before, parsed.citations);
    assert.ok(grounded.includes("No papers cited for this prompt."));
    assert.ok(!grounded.includes("Draft citation."));
  }
});

test("source material delimiters and literal marker text stay in the revised body", () => {
  const source = `The migration is complete.\n\nThe original notes included <source_citations> and ### PROMPT START as literal text.`;
  const body = `Summarize the following update:\n<source_material>\n${source}\n</source_material>`;
  const output = `<refined_prompt>\n${body}\n</refined_prompt>\n<source_citations>\n[1] The prompt uses the paper's structured summary technique.\n</source_citations>`;
  const parsed = parseRefinementResponse(output, 1);
  assert.equal(parsed.body, body);
  assert.deepEqual(parsed.citations, ["[1] The prompt uses the paper's structured summary technique."]);

  const noWrapper = `${body}\n<source_citations>\n[1] Structured summary.\n</source_citations>`;
  assert.equal(parseRefinementResponse(noWrapper, 1).body, body);

  const unclosedCitations = `${body}\n<source_citations>\n[1] Structured summary.`;
  assert.deepEqual(parseRefinementResponse(unclosedCitations, 1), { body, citations: [] });
});

test("the final V2 payload lists only citations from the revised prompt", () => {
  const supplied = [
    { title: "Draft paper", similarity: 0.8, citation_url: "https://example.test/draft" },
    { title: "Revision paper", similarity: 0.7, citation_url: "https://example.test/revision" },
  ];
  const before = "<context_grounding>\n[1] Draft paper shaped the initial output format.\n</context_grounding>\n### PROMPT START";
  const response = "<refined_prompt>Revised prompt body.</refined_prompt><source_citations>[2] Revision paper shaped the revised output format.</source_citations>";
  const parsed = parseRefinementResponse(response, supplied.length);
  const finalPrompt = `${replaceContextGrounding(before, parsed.citations)}\n${parsed.body}\n### PROMPT END`;
  assert.deepEqual(getCitedSources(finalPrompt, supplied).map((source) => source.id), [2]);

  const missing = parseRefinementResponse("<refined_prompt>Revised prompt body.</refined_prompt>", supplied.length);
  assert.deepEqual(getCitedSources(replaceContextGrounding(before, missing.citations), supplied), []);
});
