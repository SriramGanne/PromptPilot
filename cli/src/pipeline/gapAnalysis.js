import OpenAI from 'openai';
import { getConfig } from '../config.js';

const REASONING_MODEL = 'google/gemma-3n-E4B-it';

const GAP_ANALYSIS_SYSTEM = `You are a prompt clarity evaluator. Analyse the user's raw intent and return ONLY a JSON object — no prose, no markdown fences.

Schema:
{
  "sufficient": boolean,
  "clarityScore": number,
  "missingDimensions": string[],
  "questions": string[]
}

Dimensions to check:
- target_audience   : Who will read/use the output?
- output_format     : Expected structure (paragraph, list, JSON, code, table…)?
- tone              : Formal, casual, technical, empathetic…?
- task_constraints  : Word limits, forbidden topics, required sections?
- domain_context    : Is enough subject-matter context provided?

Rules:
- If 3+ dimensions are missing → sufficient: false
- clarityScore < 0.7 → sufficient: false
- Return at most 3 questions, each under 15 words.`;

function extractJSON(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through */ }
  }
  return null;
}

/**
 * Analyse whether a raw prompt has enough clarity to synthesize.
 * @param {string} rawPrompt
 * @returns {Promise<{sufficient: boolean, clarityScore: number, questions: string[], missingDimensions: string[]}>}
 */
export async function analyzeGaps(rawPrompt) {
  const config = getConfig();
  const together = new OpenAI({
    apiKey: config.TOGETHER_API_KEY,
    baseURL: 'https://api.together.xyz/v1',
  });

  const response = await together.chat.completions.create({
    model: REASONING_MODEL,
    messages: [
      { role: 'system', content: GAP_ANALYSIS_SYSTEM },
      { role: 'user', content: rawPrompt },
    ],
    temperature: 0.1,
    max_tokens: 300,
  });

  const raw = response.choices[0].message.content.trim();
  const parsed = extractJSON(raw);

  if (!parsed) {
    console.warn('Gap analysis JSON parse failed; defaulting to sufficient=false. Raw:', raw);
    return {
      sufficient: false,
      clarityScore: 0.5,
      questions: [
        'Who is the intended audience for the output?',
        'What format or structure should the output take?',
        'Are there any specific constraints or requirements to follow?',
      ],
      missingDimensions: ['target_audience', 'output_format', 'task_constraints'],
    };
  }

  return {
    sufficient: Boolean(parsed.sufficient),
    clarityScore: Number(parsed.clarityScore ?? 0.5),
    questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [],
    missingDimensions: Array.isArray(parsed.missingDimensions) ? parsed.missingDimensions : [],
  };
}
