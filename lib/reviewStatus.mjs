export function deriveReviewStatus(result) {
  const empty = { state: null, text: "", insight: "" };
  if (!result || typeof result !== "object") return empty;

  if (result.streaming === true && result.draft === true) {
    return { state: "running", text: "Draft ready · Quality review in progress", insight: "" };
  }

  const evaluationFailed = result.evaluationResult?.evaluation_failed;
  if (evaluationFailed === true ||
      (result.refinementTriggered === true && result.refinementSuccessful === false)) {
    return { state: "failed", text: "Review couldn't complete · Initial prompt shown", insight: "" };
  }

  if (result.refinementSuccessful === true) {
    return {
      state: "revised",
      text: "Updated after quality review",
      insight: typeof result.evaluationResult?.evaluator_insight === "string"
        ? result.evaluationResult.evaluator_insight.trim()
        : "",
    };
  }

  if (evaluationFailed === false && result.refinementTriggered === false) {
    return { state: "passed", text: "Reviewed · No changes needed", insight: "" };
  }

  return empty;
}

export function isCopyStale(copiedText, finalPrompt) {
  return typeof copiedText === "string" && copiedText.length > 0 &&
    typeof finalPrompt === "string" && finalPrompt.length > 0 &&
    copiedText !== finalPrompt;
}
