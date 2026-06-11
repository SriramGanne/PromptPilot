// Unit + regression tests for the eval-metrics core.
// Run with:  node --test
//
// These cover the testable heart of the feature without booting the OpenAI SDK:
//   1. Judge response parsing (readMetric / normalizeTo10)
//   2. Evaluation schema validation (shape of getMetricsForDisplay output)
//   3. Aggregate (composite) score calculation + weighting
//   4. UI view-model rendering safety (missing metrics → null, not a crash)
//   5. Backward compatibility with older evaluations (legacy-only payloads)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  METRICS,
  NEW_METRIC_KEYS,
  COMPOSITE_WEIGHTS,
  EVAL_THRESHOLDS,
  clampNumber,
  normalizeTo10,
  readMetric,
  computeCompositeScore,
  getMetricsForDisplay,
  resolveOverallPercent,
} from "../evalMetrics.mjs";

// ── Registry sanity ─────────────────────────────────────────────────────────

test("registry: composite weights sum to 1.0", () => {
  const sum = METRICS.reduce((s, m) => s + m.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights summed to ${sum}`);
});

test("registry: the three new metrics are present with reasoning fields", () => {
  for (const key of NEW_METRIC_KEYS) {
    const m = METRICS.find((x) => x.key === key);
    assert.ok(m, `missing metric ${key}`);
    assert.ok(m.reasoningField, `${key} must carry a reasoning field`);
    assert.ok(m.tooltip && m.tooltip.length > 10, `${key} needs a tooltip`);
  }
});

test("registry: recommended weights match the spec", () => {
  assert.equal(COMPOSITE_WEIGHTS.intentFidelity, 0.3);
  assert.equal(COMPOSITE_WEIGHTS.constraintAdherence, 0.25);
  assert.equal(COMPOSITE_WEIGHTS.taskSuccess, 0.2);
  assert.equal(COMPOSITE_WEIGHTS.outputQuality, 0.15);
  assert.equal(COMPOSITE_WEIGHTS.techniquePreservation, 0.1);
});

// ── 1. Scoring math ──────────────────────────────────────────────────────────

test("normalizeTo10: clamps, rescales a 0–100 reply, falls back on garbage", () => {
  assert.equal(normalizeTo10(8, 0), 8);
  assert.equal(normalizeTo10(85, 0), 8.5); // model answered on 0–100 by mistake
  assert.equal(normalizeTo10(12, 0), 1.2); // (10,100] → /10 (inherited rescale rule)
  assert.equal(normalizeTo10(150, 0), 10); // >100 → clamp to 10
  assert.equal(normalizeTo10(-3, 0), 0); // clamp low
  assert.equal(normalizeTo10("nope", null), null); // fallback
});

test("clampNumber: clamps within range and falls back", () => {
  assert.equal(clampNumber(50, 0, 100, 0), 50);
  assert.equal(clampNumber(250, 0, 100, 0), 100);
  assert.equal(clampNumber(undefined, 0, 100, 7), 7);
});

// ── 2. Judge response parsing ─────────────────────────────────────────────────

test("readMetric: parses a nested {score, reasoning} object", () => {
  const parsed = { taskSuccess: { score: 7, reasoning: "  accomplishes the task  " } };
  const m = readMetric(parsed, "taskSuccess");
  assert.equal(m.score, 7);
  assert.equal(m.reasoning, "accomplishes the task");
});

test("readMetric: tolerates a bare numeric score (model dropped the wrapper)", () => {
  const m = readMetric({ outputQuality: 9 }, "outputQuality");
  assert.equal(m.score, 9);
  assert.equal(m.reasoning, "");
});

test("readMetric: missing key → score null, empty reasoning", () => {
  const m = readMetric({}, "constraintAdherence");
  assert.equal(m.score, null);
  assert.equal(m.reasoning, "");
});

test("readMetric: rescales a 0–100 nested score", () => {
  const m = readMetric({ constraintAdherence: { score: 80, reasoning: "x" } }, "constraintAdherence");
  assert.equal(m.score, 8);
});

// ── 3. Aggregate (composite) score ─────────────────────────────────────────────

test("composite: all five metrics → correct weighted 0–100 value", () => {
  // All 8/10 → weighted avg 8 → 80.
  const c = computeCompositeScore({
    intentFidelity: 8,
    constraintAdherence: 8,
    taskSuccess: 8,
    outputQuality: 8,
    techniquePreservation: 8,
  });
  assert.equal(c, 80);
});

test("composite: weighting is applied (not a plain mean)", () => {
  // Only intentFidelity high; everything else 0. Plain mean would be 6 → 60.
  // Weighted: 10*0.3 = 3 → /1.0 → 30.
  const c = computeCompositeScore({
    intentFidelity: 10,
    constraintAdherence: 0,
    taskSuccess: 0,
    outputQuality: 0,
    techniquePreservation: 0,
  });
  assert.equal(c, 30);
});

test("composite: partial (legacy-only) set re-normalises weights", () => {
  // Old payload: only the two legacy metrics. Weights 0.3 + 0.1 = 0.4.
  // (9*0.3 + 5*0.1)/0.4 = (2.7+0.5)/0.4 = 8.0 → 80.
  const c = computeCompositeScore({ intentFidelity: 9, techniquePreservation: 5 });
  assert.equal(c, 80);
});

test("composite: empty input → null (no crash, no NaN)", () => {
  assert.equal(computeCompositeScore({}), null);
  assert.equal(computeCompositeScore(null), null);
});

// ── 4. UI view-model rendering safety ──────────────────────────────────────────

function fullJudgeResult(overrides = {}) {
  return {
    evaluation_failed: false,
    faithfulness_score: 8,
    context_relevancy_score: 7,
    overall_score: 82,
    constraint_adherence_score: 9,
    constraint_adherence_reasoning: "Honors all stated constraints.",
    task_success_score: 8,
    task_success_reasoning: "Would produce the requested artifact.",
    output_quality_score: 7,
    output_quality_reasoning: "Clear and well organized.",
    composite_score: 80,
    evaluator_insight: "Strong, well-structured prompt.",
    improvement_suggestions: [],
    ...overrides,
  };
}

test("getMetricsForDisplay: emits all five metrics in registry order", () => {
  const cards = getMetricsForDisplay(fullJudgeResult());
  assert.equal(cards.length, 5);
  assert.deepEqual(
    cards.map((c) => c.key),
    METRICS.map((m) => m.key)
  );
});

test("getMetricsForDisplay: new metrics carry score + reasoning, legacy carry score only", () => {
  const cards = getMetricsForDisplay(fullJudgeResult());
  const constraint = cards.find((c) => c.key === "constraintAdherence");
  assert.equal(constraint.score, 9);
  assert.equal(constraint.reasoning, "Honors all stated constraints.");

  const intent = cards.find((c) => c.key === "intentFidelity");
  assert.equal(intent.score, 8);
  assert.equal(intent.reasoning, null); // legacy → shares evaluator_insight
});

test("getMetricsForDisplay: failed evaluation → every score null (UI shows —)", () => {
  const cards = getMetricsForDisplay({ evaluation_failed: true });
  assert.ok(cards.every((c) => c.score === null));
});

test("getMetricsForDisplay: undefined/garbage input does not throw", () => {
  assert.doesNotThrow(() => getMetricsForDisplay(undefined));
  assert.doesNotThrow(() => getMetricsForDisplay(null));
  assert.doesNotThrow(() => getMetricsForDisplay(42));
  const cards = getMetricsForDisplay(undefined);
  assert.equal(cards.length, 5);
  assert.ok(cards.every((c) => c.score === null));
});

// ── 5. Backward compatibility with older evaluations ──────────────────────────

test("backward-compat: old cached payload (no new metric fields) doesn't crash UI", () => {
  // A payload produced BEFORE this feature: only the legacy fields exist.
  const oldResult = {
    evaluation_failed: false,
    faithfulness_score: 8,
    context_relevancy_score: 7,
    overall_score: 79,
    evaluator_insight: "ok",
    improvement_suggestions: [],
  };
  const cards = getMetricsForDisplay(oldResult);
  // Legacy metrics resolve…
  assert.equal(cards.find((c) => c.key === "intentFidelity").score, 8);
  assert.equal(cards.find((c) => c.key === "techniquePreservation").score, 7);
  // …new metrics are simply absent (null), not errors.
  for (const key of NEW_METRIC_KEYS) {
    const card = cards.find((c) => c.key === key);
    assert.equal(card.score, null);
    assert.equal(card.reasoning, null);
  }
});

test("resolveOverallPercent: prefers composite, then overall_score, then legacy mean", () => {
  // composite present
  assert.equal(resolveOverallPercent({ composite_score: 88 }), 88);
  // no composite but judged overall
  assert.equal(
    resolveOverallPercent({ evaluation_failed: false, overall_score: 79 }),
    79
  );
  // legacy fallback (no evaluationResult) → mean of 0–1 metrics → %
  assert.equal(resolveOverallPercent(null, { faithfulness: 0.8, relevancy: 0.6 }), 70);
  // nothing available
  assert.equal(resolveOverallPercent(null, {}), null);
});

// ── Regression: thresholds include the new gated metrics ───────────────────────

test("thresholds: constraintAdherence and taskSuccess are gated; outputQuality is not", () => {
  assert.equal(EVAL_THRESHOLDS.constraintAdherence, 7);
  assert.equal(EVAL_THRESHOLDS.taskSuccess, 7);
  assert.equal(EVAL_THRESHOLDS.faithfulness, 7);
  assert.equal(EVAL_THRESHOLDS.contextRelevancy, 7);
  assert.equal(EVAL_THRESHOLDS.outputQuality, undefined);
});
