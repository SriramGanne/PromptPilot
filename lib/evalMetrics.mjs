// ---------------------------------------------------------------------------
// PromptPilot Eval Layer — Metric definitions, scoring math & view-model
//
// SINGLE SOURCE OF TRUTH for the judge's metric set. Deliberately dependency
// FREE (no `openai`, no Next, no env access) so it can be:
//   - imported by the orchestration/eval code (lib/evaluatePrompt.js),
//   - imported by the client component (app/page.js), and
//   - imported directly by `node --test` unit tests without booting the SDK.
//
// SCALE DECISION
// --------------
// The two pre-existing metrics (faithfulness → "Intent Fidelity",
// contextRelevancy → "Technique Use/Preservation") are graded as INTEGERS on a
// 0–10 scale, with `overall` on 0–100. The new metrics' spec lists 1/3/5/7
// anchors, but the project requirement is explicit: "use the same scoring scale
// already used elsewhere in the application." So every metric below is scored
// on the SAME 0–10 scale; the 1/3/5/7 anchors are translated to 0–10 anchors in
// the rubric strings. This keeps one mental model end-to-end (bars, composite,
// thresholds) and avoids mixing 0–10 and 1–7 in the same dashboard.
// ---------------------------------------------------------------------------

/**
 * Metric registry. `key` is the canonical short id; `scoreField`/`reasoningField`
 * are the FLAT snake_case fields on the evaluationResult object (kept flat for
 * backward compatibility with refinePrompt, the Supabase logger, and every
 * already-cached Redis payload). `weight` feeds the composite (see below).
 *
 * The first two entries are the PRE-EXISTING metrics, re-labelled to the names
 * the UI already shows. They carry no per-metric reasoning of their own (they
 * share the judge's single `evaluator_insight`), so `reasoningField` is null.
 */
export const METRICS = [
  {
    key: "intentFidelity",
    label: "Intent Fidelity",
    tooltip:
      "Measures whether the prompt faithfully captures the user's original intent without dropping, inventing, or contradicting requirements.",
    scoreField: "faithfulness_score",
    reasoningField: null, // shares evaluator_insight
    weight: 0.3,
    legacy: true,
  },
  {
    key: "constraintAdherence",
    label: "Constraint Adherence",
    tooltip:
      "Measures whether the output follows explicit prompt requirements and constraints.",
    scoreField: "constraint_adherence_score",
    reasoningField: "constraint_adherence_reasoning",
    weight: 0.25,
    legacy: false,
  },
  {
    key: "taskSuccess",
    label: "Task Success",
    tooltip:
      "Measures whether the output successfully achieves the user's requested objective.",
    scoreField: "task_success_score",
    reasoningField: "task_success_reasoning",
    weight: 0.2,
    legacy: false,
  },
  {
    key: "outputQuality",
    label: "Output Quality",
    tooltip:
      "Measures overall clarity, completeness, organization, and usefulness.",
    scoreField: "output_quality_score",
    reasoningField: "output_quality_reasoning",
    weight: 0.15,
    legacy: false,
  },
  {
    key: "techniquePreservation",
    label: "Technique Use",
    tooltip:
      "Measures whether the prompt applies prompt-engineering techniques appropriate for the target model (structure, role, constraints, output format).",
    scoreField: "context_relevancy_score",
    reasoningField: null, // shares evaluator_insight
    weight: 0.1,
    legacy: true,
  },
];

// The three metrics added by this feature, in judge-schema order. Used to drive
// parsing and to document exactly what's new.
export const NEW_METRIC_KEYS = ["constraintAdherence", "taskSuccess", "outputQuality"];

// ---------------------------------------------------------------------------
// Composite weighting
// ---------------------------------------------------------------------------
//
// Weighted average of the per-metric 0–10 scores, rescaled to 0–100.
//
//   Intent Fidelity ........ 30%   (does the prompt capture what was asked?)
//   Constraint Adherence ... 25%   (does it honor explicit requirements?)
//   Task Success ........... 20%   (does it actually accomplish the task?)
//   Output Quality ......... 15%   (is the result clear/complete/useful?)
//   Technique Preservation . 10%   (are model-appropriate techniques applied?)
//                            ----
//                            100%
//
// Rationale: intent + constraints together (55%) dominate because a prompt that
// drifts from intent or ignores stated constraints is wrong regardless of
// polish. Task Success (20%) captures end-to-end usefulness. Output Quality
// (15%) and Technique Preservation (10%) are quality multipliers, not gates.
//
// IMPORTANT — the weights live on each METRIC entry above (single source of
// truth). The composite is computed over ONLY the metrics actually present in a
// given evaluation (re-normalising the weights), so older cached evaluations
// that predate the new metrics still yield a sensible composite instead of NaN.
export const COMPOSITE_WEIGHTS = Object.fromEntries(
  METRICS.map((m) => [m.key, m.weight])
);

// ---------------------------------------------------------------------------
// Thresholds — a result passing ALL applicable thresholds is "good enough"
// to return without refinement. New metrics use the same 0–10 floor (7) as the
// existing ones; `overall` stays 0–100. Kept conservative so refinement is
// triggered by genuine weakness, not noise.
// ---------------------------------------------------------------------------
export const EVAL_THRESHOLDS = {
  faithfulness: 7, // Intent Fidelity
  contextRelevancy: 7, // Technique Preservation
  constraintAdherence: 7,
  taskSuccess: 7,
  // outputQuality intentionally has NO threshold: it's a quality signal, not a
  // correctness gate, so a merely-"good" (not excellent) output shouldn't force
  // a refinement pass on its own.
  overall: 75,
};

// ---------------------------------------------------------------------------
// Scoring math (pure)
// ---------------------------------------------------------------------------

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerce a judge score onto the 0–10 scale, defending against a model that
 * ignores the rubric and answers on a 0–100 scale (e.g. returns 85 for 8.5).
 * Values in (10, 100] are divided by 10; everything is clamped to [0, 10].
 * A genuine 0–1 reply is intentionally NOT rescaled (indistinguishable from a
 * legitimate "1/10").
 */
export function normalizeTo10(value, fallback) {
  let n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 10 && n <= 100) n = n / 10;
  return Math.min(10, Math.max(0, n));
}

/**
 * Pull a {score, reasoning} metric out of a parsed judge JSON object. The judge
 * is asked to emit each new metric as a nested object, but small models are
 * inconsistent — so we also accept a bare number at the same key (treating
 * reasoning as absent). Returns { score: number|null, reasoning: string }.
 */
export function readMetric(parsed, key) {
  const raw = parsed?.[key];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const score = normalizeTo10(raw.score, null);
    const reasoning = typeof raw.reasoning === "string" ? raw.reasoning.trim() : "";
    return { score, reasoning };
  }
  // Tolerate a bare numeric score at the key.
  const score = normalizeTo10(raw, null);
  return { score, reasoning: "" };
}

/**
 * Compute the 0–100 weighted composite over whatever metrics are present.
 * `scores` is a map keyed by METRIC.key → number (0–10) or null/undefined.
 * Weights are re-normalised across present metrics, so a partial set (e.g. an
 * old evaluation with only the two legacy metrics) still produces a number.
 * Returns null when NO metric is present.
 */
export function computeCompositeScore(scores) {
  let weighted = 0;
  let weightSum = 0;
  for (const m of METRICS) {
    const v = scores?.[m.key];
    if (typeof v === "number" && Number.isFinite(v)) {
      weighted += v * m.weight;
      weightSum += m.weight;
    }
  }
  if (weightSum === 0) return null;
  // weighted/weightSum is on 0–10; rescale to 0–100 and round to an integer.
  return Math.round((weighted / weightSum) * 10);
}

/**
 * Build the ordered view-model the UI maps over. Each entry:
 *   { key, label, tooltip, score: number|null (0–10), reasoning: string|null }
 *
 * Backward compatibility: if `evaluationResult` is missing (or failed), or a
 * given metric's field is absent (old cached payload predating this feature),
 * that metric's `score` is null — the UI renders a "—" placeholder rather than
 * crashing. Legacy metrics never carry per-metric reasoning (reasoning: null);
 * their explanation is the shared `evaluator_insight`.
 */
export function getMetricsForDisplay(evaluationResult) {
  const r = evaluationResult && typeof evaluationResult === "object" ? evaluationResult : {};
  const failed = r.evaluation_failed === true;
  return METRICS.map((m) => {
    const rawScore = failed ? null : r[m.scoreField];
    const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;
    const reasoning =
      m.reasoningField && typeof r[m.reasoningField] === "string" && r[m.reasoningField].trim()
        ? r[m.reasoningField].trim()
        : null;
    return { key: m.key, label: m.label, tooltip: m.tooltip, score, reasoning };
  });
}

/**
 * Resolve the single headline "Overall" percentage (0–100) for a result,
 * preferring the documented weighted composite, then the judge's holistic
 * `overall_score`, then a legacy mean of the two 0–10 metrics — so every payload
 * shape (new, old-cached, judge-failed-with-fallbacks) renders something.
 * Returns null when nothing is available.
 */
export function resolveOverallPercent(evaluationResult, fallback = {}) {
  const r = evaluationResult ?? {};
  if (typeof r.composite_score === "number" && Number.isFinite(r.composite_score)) {
    return r.composite_score;
  }
  if (r.evaluation_failed === false && typeof r.overall_score === "number") {
    return Math.round(r.overall_score);
  }
  const { faithfulness, relevancy } = fallback; // each 0–1 or null
  if (typeof faithfulness === "number" && typeof relevancy === "number") {
    return Math.round(((faithfulness + relevancy) / 2) * 100);
  }
  return null;
}
