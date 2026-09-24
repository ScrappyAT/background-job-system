import OpenAI from 'openai';
import { z } from 'zod';

import { config } from '../config/env';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export const analysisResultSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'mixed']),
  rating: z.number().int().min(1).max(5),
  themes: z.array(z.string()),
  complaints: z.array(z.string()),
  quote: z.string().min(1),
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = config.deepseekApiKey;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set; cannot call the DeepSeek API');
  }
  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: DEEPSEEK_BASE_URL,
      timeout: config.deepseekTimeoutMs,
      maxRetries: 0,
    });
  }
  return client;
}

function buildMessages(review: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: [
        'You are a customer-review analyst.',
        'Analyse a single customer review and return ONLY a JSON object with exactly these fields:',
        '- "sentiment": "positive", "negative", or "mixed"',
        '- "rating": an integer from 1 to 5',
        '- "themes": an array of strings listing the important topics discussed',
        '- "complaints": an array of strings listing specific problems mentioned; empty array if none',
        '- "quote": a short string copied VERBATIM from the supplied review that best represents it',
        'Do not add commentary before or after the JSON object.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: review,
    },
  ];
}

export async function analyzeReview(review: string): Promise<AnalysisResult> {
  if (!config.deepseekApiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set; cannot call the DeepSeek API');
  }

  const startedAt = Date.now();
  const model = config.deepseekModel;
  console.log(`[ai] deepseek request started model=${model}`);

  try {
    const completion = await getClient().chat.completions.create({
      model,
      messages: buildMessages(review),
      response_format: { type: 'json_object' },
    });

    const durationMs = Date.now() - startedAt;
    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.log(`[ai] deepseek request failed model=${model} durationMs=${durationMs} (empty response)`);
      throw new Error('DeepSeek returned an empty response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      console.log(`[ai] deepseek request failed model=${model} durationMs=${durationMs} (invalid JSON)`);
      throw new Error(
        `DeepSeek returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const result = analysisResultSchema.safeParse(parsed);
    if (!result.success) {
      console.log(`[ai] deepseek request failed model=${model} durationMs=${durationMs} (schema validation)`);
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`DeepSeek analysis failed schema validation: ${issues}`);
    }

    if (!review.includes(result.data.quote)) {
      console.log(`[ai] deepseek request failed model=${model} durationMs=${durationMs} (quote mismatch)`);
      throw new Error('DeepSeek returned a quote that is not present verbatim in the review');
    }

    console.log(`[ai] deepseek request succeeded model=${model} durationMs=${durationMs}`);
    return result.data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DEEPSEEK_API_KEY')) {
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[ai] deepseek request failed model=${model} durationMs=${durationMs} (${message})`);
    throw error;
  }
}