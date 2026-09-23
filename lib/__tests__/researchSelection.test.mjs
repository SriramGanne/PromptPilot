import test from "node:test";
import assert from "node:assert/strict";
import { formatResearchRecord, selectResearchWithinBudget } from "../researchSelection.mjs";

const papers = [
  { title: "First paper", content: "First technique.\nSecond paragraph.", similarity: 0.756 },
  { title: "Second paper", content: "Another technique.", similarity: 0.481 },
  { title: "Third paper", content: "Further technique.", similarity: 0.333 },
];

test("research selection supplies all qualifying papers when they fit", () => {
  const allChars = papers.map((paper, index) => formatResearchRecord(paper, index + 1)).join("\n").length;
  assert.deepEqual(selectResearchWithinBudget(papers, allChars), {
    selected: papers,
    qualifyingCount: 3,
    suppliedCount: 3,
  });
  assert.equal(formatResearchRecord(papers[0], 1),
    "[1] First paper (similarity: 0.76)\nFirst technique.\nSecond paragraph.");
});

test("research selection uses the exact formatted length including separators", () => {
  const firstTwoChars = [formatResearchRecord(papers[0], 1), formatResearchRecord(papers[1], 2)].join("\n").length;
  assert.deepEqual(selectResearchWithinBudget(papers, firstTwoChars), {
    selected: papers.slice(0, 2),
    qualifyingCount: 3,
    suppliedCount: 2,
  });
  assert.equal(selectResearchWithinBudget(papers, firstTwoChars - 1).suppliedCount, 1);
  assert.equal(selectResearchWithinBudget(papers, firstTwoChars).selected[0].content, papers[0].content);
});

test("research selection does not truncate or skip an oversized high-rank paper", () => {
  const oversized = { ...papers[0], content: "x".repeat(100) };
  const result = selectResearchWithinBudget([oversized, papers[1]], 90);
  assert.deepEqual(result, { selected: [], qualifyingCount: 2, suppliedCount: 0 });
  assert.equal(oversized.content.length, 100);
});

test("research selection handles empty, malformed, and unusable inputs", () => {
  assert.deepEqual(selectResearchWithinBudget(null), { selected: [], qualifyingCount: 0, suppliedCount: 0 });
  assert.deepEqual(selectResearchWithinBudget([]), { selected: [], qualifyingCount: 0, suppliedCount: 0 });
  assert.deepEqual(selectResearchWithinBudget([null, {}, { ...papers[0], content: " " }, papers[1]], 8000), {
    selected: [papers[1]],
    qualifyingCount: 1,
    suppliedCount: 1,
  });
  assert.equal(selectResearchWithinBudget(papers, -1).suppliedCount, 0);
  assert.equal(selectResearchWithinBudget(papers, Number.NaN).suppliedCount, 0);
});
