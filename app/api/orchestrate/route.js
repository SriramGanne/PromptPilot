import { NextResponse } from "next/server";
import OpenAI from "openai";
import { supabase } from "../../../lib/supabase";

const openai = new OpenAI({
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: "https://api.together.xyz/v1",
});

/** Internal optimizer model — always runs on Together AI */
const OPTIMIZER_MODEL = "google/gemma-3n-e4b-it";

/** Base system message for prompt rewriting */
const BASE_SYSTEM_MESSAGE = `You are a prompt rewriting engine.
Rewrite the user's raw input into a clear, concise, and structured prompt suitable for execution by a large language model.
Rules:
- Preserve original intent.
- Remove ambiguity.
- Add necessary constraints only.
- Eliminate redundant wording.
- Keep the prompt concise.
- Avoid decorative formatting.
- Ensure the output is directly executable.
- Return ONLY the rewritten prompt.
- Do not include explanations.`;

/** Model-specific hints appended to the base system message */
const MODEL_HINTS = {
  Claude:
    "- Claude responds well to structured prompts with clear sections and explicit instructions.\n- Use concise sections if helpful.",
  ChatGPT:
    "- ChatGPT responds well to direct instructions and explicit output format definitions.",
  Gemini:
    "- Gemini handles structured tasks well and benefits from clearly defined expected output.",
  Grok:
    "- Grok responds well to concise, direct prompts without excessive structure.",
};

/**
 * Approximate token count using word-based heuristic.
 * GPT tokenizers average ~1.3 tokens per whitespace-delimited word.
 */
function estimateTokens(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.ceil(words.length * 1.3);
}

/**
 * LLM call 1: Rewrite the user's prompt for clarity and token efficiency.
 * System message is model-aware — appends target-specific hints.
 * Always runs on OPTIMIZER_MODEL (Gemma 3n E4B) via Together AI.
 */
async function optimizePrompt(text, targetModel) {
  const hint = MODEL_HINTS[targetModel] || "";
  const systemMessage = hint
    ? `${BASE_SYSTEM_MESSAGE}\n${hint}`
    : BASE_SYSTEM_MESSAGE;

  const response = await openai.chat.completions.create({
    model: OPTIMIZER_MODEL,
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: text },
    ],
    temperature: 0.3,
  });

  return response.choices[0].message.content.trim();
}

/**
 * Conditional LLM call: Compress a prompt that expanded beyond the 1.5x threshold.
 * Only fires when the first optimization pass produces bloat.
 */
async function compressPrompt(text) {
  const response = await openai.chat.completions.create({
    model: OPTIMIZER_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Rewrite the following prompt to reduce token length while preserving clarity and constraints. Remove redundant wording. Do not add new sections.",
      },
      { role: "user", content: text },
    ],
    temperature: 0.2,
  });

  return response.choices[0].message.content.trim();
}

/**
 * Final LLM call: Execute the optimized prompt and return the response.
 * TODO: Re-enable when ready to test end-to-end execution.
 */
// async function executePrompt(prompt, model) {
//   const response = await openai.chat.completions.create({
//     model,
//     messages: [{ role: "user", content: prompt }],
//     temperature: 0.7,
//   });
//
//   return response.choices[0].message.content.trim();
// }

export async function POST(request) {
  try {
    const { userInput, targetModel } = await request.json();

    if (!userInput || !targetModel) {
      return NextResponse.json(
        { error: "userInput and targetModel are required." },
        { status: 400 }
      );
    }

    // --- Call 1: Optimize (model-aware for targetModel) ---
    const originalTokens = estimateTokens(userInput);
    let optimizedPrompt = await optimizePrompt(userInput, targetModel);
    let optimizedTokens = estimateTokens(optimizedPrompt);

    // --- Conditional Call 2: Compress if optimization bloated the prompt ---
    let compressionApplied = false;
    if (optimizedTokens > originalTokens * 1.5) {
      compressionApplied = true;
      optimizedPrompt = await compressPrompt(optimizedPrompt);
      optimizedTokens = estimateTokens(optimizedPrompt);
    }

    // --- Final Call (2 or 3): Execute ---
    // TODO: Re-enable when ready to test end-to-end execution.
    // const modelOutput = await executePrompt(optimizedPrompt, model);
    const modelOutput = "[Execution disabled — optimize-only mode]";

    const reductionPercent =
      originalTokens > 0
        ? Math.round(
            ((originalTokens - optimizedTokens) / originalTokens) * 100
          )
        : 0;

    // --- Log to Supabase (fire-and-forget, never blocks response) ---
    supabase
      .from("prompt_metrics")
      .insert({
        original_tokens: originalTokens,
        optimized_tokens: optimizedTokens,
        reduction_percent: reductionPercent,
        target_model: targetModel,
        compression_applied: compressionApplied,
      })
      .then(({ error: dbErr }) => {
        if (dbErr) console.error("Supabase log error:", dbErr.message);
      });

    return NextResponse.json({
      originalTokens,
      optimizedTokens,
      reductionPercent,
      optimizedPrompt,
      modelOutput,
      compressionApplied,
    });
  } catch (err) {
    console.error("Orchestrate error:", err);
    return NextResponse.json(
      { error: err.message || "Internal server error" },
      { status: 500 }
    );
  }
}
