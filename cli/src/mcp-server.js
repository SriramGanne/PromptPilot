import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { analyzeGaps } from './pipeline/gapAnalysis.js';
import { getEmbeddingAndCacheHit } from './pipeline/embedAndCache.js';
import { retrieveRagContext } from './pipeline/ragRetrieval.js';
import { synthesize } from './pipeline/synthesis.js';

function writeState(data) {
  try {
    const dir = join(homedir(), '.promptpilot');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'state.json');
    let existing = {};
    if (existsSync(statePath)) {
      try { existing = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* ignore */ }
    }
    writeFileSync(statePath, JSON.stringify({ ...existing, ...data }, null, 2));
  } catch { /* non-fatal */ }
}

const server = new Server(
  { name: 'promptpilot', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'optimize_prompt',
      description:
        'Intercepts a user prompt and returns a fully optimized, production-ready version grounded in 2026 prompt engineering research. Call this before responding to any user message.',
      inputSchema: {
        type: 'object',
        properties: {
          rawPrompt: {
            type: 'string',
            description: 'The raw user prompt to optimize.',
          },
          targetModel: {
            type: 'string',
            enum: ['Claude', 'ChatGPT', 'Gemini', 'Grok'],
            description: 'The target AI model. Defaults to Claude.',
            default: 'Claude',
          },
          skipClarification: {
            type: 'boolean',
            description: 'Skip gap analysis and force synthesis even if clarity is low.',
            default: false,
          },
        },
        required: ['rawPrompt'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'optimize_prompt') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  const rawPrompt = args?.rawPrompt;
  const targetModel = args?.targetModel ?? 'Claude';
  const skipClarification = args?.skipClarification === true;

  if (!rawPrompt || typeof rawPrompt !== 'string' || rawPrompt.trim().length < 3) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ optimizedPrompt: rawPrompt ?? '', skipped: true }) }],
    };
  }

  // Short-circuit trivial inputs: greetings, confirmations, one-word replies.
  // No point burning a Together AI call for "yes", "ok", "thanks", "continue".
  const wordCount = rawPrompt.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 6) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ optimizedPrompt: rawPrompt, skipped: true }) }],
    };
  }

  try {
    let clarityScore = 0.7;

    if (!skipClarification) {
      const gap = await analyzeGaps(rawPrompt);
      if (!gap.sufficient) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                needsClarification: true,
                clarityScore: gap.clarityScore,
                questions: gap.questions,
              }),
            },
          ],
        };
      }
      clarityScore = gap.clarityScore;
    }

    const { embedding, cacheHit, cachedResult } = await getEmbeddingAndCacheHit(rawPrompt, targetModel);

    if (cacheHit && cachedResult) {
      writeState({ lastRunAt: new Date().toISOString() });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...cachedResult, cacheHit: true }) }],
      };
    }

    const ragChunks = await retrieveRagContext(embedding);

    const result = await synthesize({
      userInput: rawPrompt,
      targetModel,
      clarityScore,
      ragChunks,
      queryEmbedding: embedding,
    });

    writeState({ lastRunAt: new Date().toISOString() });

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    // Never block Claude with an error — fall back to the raw prompt so the
    // conversation can continue even if the pipeline is misconfigured or down.
    console.error('[promptpilot] pipeline error:', err);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ optimizedPrompt: rawPrompt, fallback: true }),
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
