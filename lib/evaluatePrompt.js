import OpenAI from "openai";
import { JUDGE_MODEL, JUDGE_ENABLED } from "./eval-config";
import {
  EVAL_THRESHOLDS,
  clampNumber,
  normalizeTo10,
  readMetric,
  computeCompositeScore,
} from "./evalMetrics.mjs";

// ---------------------------------------------------------------------------
// PromptPilot Eval Layer — LLM-as-a-Judge (GPT-5-mini)
//
// Grades a Gemma-optimized prompt (V1) against the user's intent and the
// retrieved knowledge context, then decides whether refinement is needed.
//
// SAFETY CONTRACT (per spec):
//   - This module NEVER throws. Any failure → { evaluation_failed: true }.
//   - The caller treats evaluation_failed as "skip refinement, return V1".
//   - The judge runs on its OWN OpenAI client — it must NOT share or reuse the
//     Together AI client (which is dedicated to Gemma optimization/refinement).
// ---------------------------------------------------------------------------

// Dedicated judge client. NO baseURL → hits OpenAI directly (never Together).
// Guarded so a missing key yields null instead of throwing at import time,
// which would otherwise crash the orchestration route on require.
const judgeClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// GPT-5 reasoning models reject `max_tokens` (use `max_completion_tokens`) and
// reject non-default `temperature` — so neither appears below. Headroom is
// generous because reasoning tokens are spent before the JSON is emitted.
const JUDGE_MAX_COMPLETION_TOKENS = 2000;

// Hard ceiling for a judge call. The judge runs ~13s; 30s catches a hung
// provider. On timeout the call throws → caught → { evaluation_failed: true },
// so the pipeline simply skips refinement and returns V1.
const JUDGE_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Judge rubric (system prompt)
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `You are a strict evaluator of PROMPTS (LLM-as-a-judge). The artifact under review is an OPTIMIZED PROMPT — a set of instructions written to be sent to an AI model. You are NOT answering the prompt; you are grading its quality. Return ONLY a JSON object — no prose, no markdown fences.

IMPORTANT — what you are measuring:
- A good optimized prompt APPLIES techniques drawn from the retrieved research; it does NOT quote, copy, or restate that research. Do NOT penalise a prompt for failing to repeat the retrieved context — that is expected and correct.

Schema:
{
  "faithfulness": number,      // 0-10 INTENT FIDELITY: does the prompt faithfully capture the user's original intent — covering what they asked, without inventing requirements, dropping requirements, or contradicting them?
  "contextRelevancy": number,  // 0-10 TECHNIQUE USE: does the prompt apply prompt-engineering techniques appropriate for the target model (clear structure, role, constraints, output format)? Best practices applied well = high, even if no research is quoted.
  "constraintAdherence": { "score": number, "reasoning": string },  // 0-10: to what extent does the prompt satisfy the EXPLICIT constraints/requirements (required format, length limits, audience, tone, output structure, numbered lists, bullet counts, JSON, required sections)?
  "taskSuccess":         { "score": number, "reasoning": string },  // 0-10: to what extent would the prompt, if followed, successfully accomplish the user's requested task (produce the requested artifact / solve the problem / complete the analysis / yield an actionable result)?
  "outputQuality":       { "score": number, "reasoning": string },  // 0-10: overall quality and usefulness of the prompt independent of intent preservation — clarity, completeness, organization, readability, practical usefulness.
  "overall": number,           // 0-100: holistic production-readiness of the prompt for the target model
  "evaluator_insight": string, // one concise sentence (under 40 words) summarising the single most important reason for the scores
  "suggestions": string[]      // concrete, minimal improvements for weak areas; [] if the prompt is already strong
}

Scoring rules:
- Be calibrated. A clear, well-structured prompt that captures the user's intent should score 7-9 on faithfulness and contextRelevancy — reserve low scores for genuine defects.
- ALL metric scores (faithfulness, contextRelevancy, constraintAdherence.score, taskSuccess.score, outputQuality.score) are on the SAME 0-10 INTEGER scale; overall is 0-100. Do NOT use a 0-1 or 1-7 scale.
- 0-10 anchors for constraintAdherence / taskSuccess / outputQuality:
    ~2 = ignores most constraints / fails the task / poor quality;
    ~4 = partially follows constraints / partially accomplishes / below average;
    ~7 = follows nearly all constraints / largely accomplishes / good;
    ~9-10 = fully satisfies all explicit constraints / completely accomplishes / excellent.
- For constraintAdherence, taskSuccess and outputQuality, "reasoning" is ONE concise sentence (under 30 words) justifying that metric's score. No markdown, no lists.
- evaluator_insight is a single plain-language sentence — no markdown, no lists.
- Each suggestion must be specific, actionable, and under 25 words.
- Focus suggestions ONLY on weak areas. Return at most 4 suggestions.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJSON(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  return null;
}

// clampNumber + normalizeTo10 now live in ./evalMetrics.mjs (shared with the UI
// and the unit tests) and are imported above.

function formatRagBlock(ragChunks) {
  if (!Array.isArray(ragChunks) || ragChunks.length === 0) {
    return "No knowledge-vault context was retrieved for this intent.";
  }
  return ragChunks
    .map((c, i) => `[${i + 1}] ${c.title ?? "untitled"}\n${c.content ?? ""}`)
    .join("\n\n");
}

function buildJudgeRequest({ userIntent, ragChunks, optimizedPromptV1, targetModel }) {
  return `Evaluate the optimized prompt below. Score it and, only where weak, suggest minimal improvements. Respond with the JSON schema described in the system message.

## ORIGINAL USER INTENT
${userIntent}

## TARGET MODEL
${targetModel}

## RETRIEVED KNOWLEDGE VAULT CHUNKS
${formatRagBlock(ragChunks)}

## OPTIMIZED PROMPT V1 (the artifact under evaluation)
${optimizedPromptV1}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a Gemma-optimized prompt with the GPT-5-mini judge.
 *
 * Never throws. On any problem (judge disabled, missing API key, provider
 * error, malformed JSON) it returns { evaluation_failed: true } so the caller
 * can skip refinement and return V1 without crashing the orchestration flow.
 *
 * @param {object}   input
 * @param {string}   input.userIntent        - Original (sanitized) user intent.
 * @param {object[]} input.ragChunks         - Retrieved knowledge chunks ({ title, content, ... }).
 * @param {string}   input.optimizedPromptV1 - The Gemma V1 output to grade.
 * @param {string}   input.targetModel       - Claude / ChatGPT / Gemini / Grok.
 * @returns {Promise<
 *   | { evaluation_failed: true,  reason?: string }
 *   | { evaluation_failed: false, faithfulness_score: number, context_relevancy_score: number,
 *       overall_score: number,
 *       constraint_adherence_score: number, constraint_adherence_reasoning: string,
 *       task_success_score: number, task_success_reasoning: string,
 *       output_quality_score: number, output_quality_reasoning: string,
 *       composite_score: number|null,
 *       evaluator_insight: string, improvement_suggestions: string[],
 *       refinement_required: boolean, latencyMs: number }
 * >}
 *
 * Field names are snake_case to match the orchestration contract: refinePrompt
 * consumes evaluationResult.faithfulness_score / .context_relevancy_score /
 * .improvement_suggestions / .evaluator_insight verbatim.
 */
export async function evaluatePrompt(input) {
  // Master switch — when disabled, skip evaluation entirely (caller keeps V1).
  if (!JUDGE_ENABLED) {
    return { evaluation_failed: true, reason: "judge_disabled" };
  }

  // Safety check before evaluation — no key means no judge.
  if (!process.env.OPENAI_API_KEY || !judgeClient) {
    return { evaluation_failed: true, reason: "missing_api_key" };
  }

  const { optimizedPromptV1 } = input ?? {};
  if (typeof optimizedPromptV1 !== "string" || !optimizedPromptV1.trim()) {
    return { evaluation_failed: true, reason: "missing_v1" };
  }

  const startedAt = Date.now();

  let response;
  try {
    response = await judgeClient.chat.completions.create(
      {
        model: JUDGE_MODEL, // "gpt-5-mini"
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: buildJudgeRequest(input) },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: JUDGE_MAX_COMPLETION_TOKENS,
      },
      // Bound the call (one retry max) so a hung judge can't stall the pipeline.
      { timeout: JUDGE_TIMEOUT_MS, maxRetries: 1 }
    );
  } catch (err) {
    console.warn(`[judge] evaluation error after ${Date.now() - startedAt}ms:`, err?.message);
    return { evaluation_failed: true, reason: "judge_error" };
  }

  const latencyMs = Date.now() - startedAt;
  const raw = response?.choices?.[0]?.message?.content?.trim() ?? "";
  const parsed = extractJSON(raw);

  if (!parsed) {
    console.warn("[judge] unparseable response. Head:", raw.slice(0, 200));
    return { evaluation_failed: true, reason: "invalid_response" };
  }

  // Coerce + clamp. faithfulness/relevancy normalise onto 0-10 (defending
  // against a 0-100 reply); overall clamps onto 0-100. Defaults to 0 → weak.
  const faithfulness_score = normalizeTo10(parsed.faithfulness, 0);
  const context_relevancy_score = normalizeTo10(parsed.contextRelevancy, 0);
  const overall_score = clampNumber(parsed.overall, 0, 100, 0);

  // New metrics — each parsed as { score (0-10), reasoning }. readMetric tolerates
  // a bare number (some small models drop the wrapper object). A missing metric
  // yields score:null; we default the stored score to 0 (treated as weak) but
  // keep the reasoning string so the UI can explain why a card is empty.
  const constraint = readMetric(parsed, "constraintAdherence");
  const task = readMetric(parsed, "taskSuccess");
  const quality = readMetric(parsed, "outputQuality");
  const constraint_adherence_score = constraint.score ?? 0;
  const task_success_score = task.score ?? 0;
  const output_quality_score = quality.score ?? 0;

  // Documented weighted composite (0-100). Computed over the metrics actually
  // present; see COMPOSITE_WEIGHTS in evalMetrics.mjs for the rationale.
  const composite_score = computeCompositeScore({
    intentFidelity: faithfulness_score,
    constraintAdherence: constraint_adherence_score,
    taskSuccess: task_success_score,
    outputQuality: output_quality_score,
    techniquePreservation: context_relevancy_score,
  });

  const evaluator_insight =
    typeof parsed.evaluator_insight === "string" ? parsed.evaluator_insight.trim() : "";

  const improvement_suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.filter((s) => typeof s === "string" && s.trim()).slice(0, 4)
    : [];

  // Refinement is required if ANY gated metric falls below its threshold. The
  // new constraint-adherence and task-success floors join the existing ones;
  // output quality is intentionally NOT a gate (see EVAL_THRESHOLDS comment).
  const refinement_required =
    faithfulness_score < EVAL_THRESHOLDS.faithfulness ||
    context_relevancy_score < EVAL_THRESHOLDS.contextRelevancy ||
    constraint_adherence_score < EVAL_THRESHOLDS.constraintAdherence ||
    task_success_score < EVAL_THRESHOLDS.taskSuccess ||
    overall_score < EVAL_THRESHOLDS.overall;

  return {
    evaluation_failed: false,
    faithfulness_score,
    context_relevancy_score,
    overall_score,
    // New metrics (flat fields, additive — old consumers ignore them):
    constraint_adherence_score,
    constraint_adherence_reasoning: constraint.reasoning,
    task_success_score,
    task_success_reasoning: task.reasoning,
    output_quality_score,
    output_quality_reasoning: quality.reasoning,
    composite_score,
    evaluator_insight,
    improvement_suggestions,
    refinement_required,
    latencyMs,
  };
}
