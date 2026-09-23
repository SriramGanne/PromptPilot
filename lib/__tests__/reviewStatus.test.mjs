import test from "node:test";
import assert from "node:assert/strict";
import { deriveReviewStatus, isCopyStale } from "../reviewStatus.mjs";

test("review status covers the four visible states", () => {
  assert.deepEqual(deriveReviewStatus({ streaming: true, draft: true }), {
    state: "running", text: "Draft ready · Quality review in progress", insight: "",
  });
  assert.deepEqual(deriveReviewStatus({ evaluationResult: { evaluation_failed: false }, refinementTriggered: false }), {
    state: "passed", text: "Reviewed · No changes needed", insight: "",
  });
  assert.deepEqual(deriveReviewStatus({
    evaluationResult: { evaluation_failed: false, evaluator_insight: "  The structure needed a clearer output format.  " },
    refinementTriggered: true,
    refinementSuccessful: true,
  }), {
    state: "revised", text: "Updated after quality review", insight: "The structure needed a clearer output format.",
  });
  assert.deepEqual(deriveReviewStatus({ evaluationResult: { evaluation_failed: true } }), {
    state: "failed", text: "Review couldn't complete · Initial prompt shown", insight: "",
  });
  assert.equal(deriveReviewStatus({ refinementTriggered: true, refinementSuccessful: false }).state, "failed");
});

test("legacy and incomplete results do not claim a review finished", () => {
  for (const result of [null, {}, { cacheHit: true }, { streaming: true },
    { evaluationResult: { evaluation_failed: false } },
    { refinementSuccessful: false }]) {
    assert.deepEqual(deriveReviewStatus(result), { state: null, text: "", insight: "" });
  }
});

test("cache hits derive their review status from cached fields", () => {
  assert.equal(deriveReviewStatus({
    cacheHit: true, evaluationResult: { evaluation_failed: false }, refinementTriggered: false,
    refinementSuccessful: false,
  }).state, "passed");
  assert.equal(deriveReviewStatus({
    cacheHit: true, evaluationResult: { evaluation_failed: false }, refinementTriggered: true,
    refinementSuccessful: true,
  }).state, "revised");
});

test("a copy is stale only when a later final prompt differs", () => {
  assert.equal(isCopyStale("Draft prompt", "Revised prompt"), true);
  assert.equal(isCopyStale("Draft prompt", "Draft prompt"), false);
  assert.equal(isCopyStale(null, "Revised prompt"), false);
  assert.equal(isCopyStale("", "Revised prompt"), false);
  assert.equal(isCopyStale("Draft prompt", ""), false);
});
