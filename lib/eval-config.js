// ---------------------------------------------------------------------------
// PromptPilot Eval Layer — Judge configuration
//
// Central config for the LLM-as-a-Judge evaluation stage that runs after Gemma
// optimization. Keeping these values in one place means the orchestration route
// and any refinement logic read from a single source of truth.
// ---------------------------------------------------------------------------

// Model used to grade optimized prompts. Reuses the existing OpenAI client.
export const JUDGE_MODEL = "gpt-5-mini";

// Master switch. When false, the pipeline skips evaluation entirely and returns
// the Gemma-optimized prompt unchanged (no judge call, no refinement).
export const JUDGE_ENABLED = true;

// Minimum acceptable scores. A result passing ALL thresholds is considered
// good enough to return without refinement.
//
// Scales (keep comparisons on matching scales downstream):
//   - faithfulness     : 0–10  (answer grounded in retrieved context)
//   - contextRelevancy : 0–10  (retrieved context relevant to the intent)
//   - overall          : 0–100 (judge's holistic quality score)
export const EVAL_THRESHOLDS = {
  faithfulness: 7,
  contextRelevancy: 7,
  overall: 75,
};
