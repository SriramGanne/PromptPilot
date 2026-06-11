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

// Thresholds + composite weights + the metric registry now live in
// lib/evalMetrics.mjs — a dependency-free module that is the single source of
// truth shared by the eval code, the UI, and the unit tests. Re-exported here
// so existing imports (`import { EVAL_THRESHOLDS } from "./eval-config"`) keep
// working unchanged.
//
// Scales (keep comparisons on matching scales downstream):
//   - faithfulness / contextRelevancy / constraintAdherence / taskSuccess : 0–10
//   - overall : 0–100 (judge's holistic quality score)
export { EVAL_THRESHOLDS, COMPOSITE_WEIGHTS, METRICS } from "./evalMetrics.mjs";
