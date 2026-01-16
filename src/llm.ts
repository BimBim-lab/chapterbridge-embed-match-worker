import OpenAI from 'openai';
import { config } from './config.js';
import { ZodSchema, ZodError } from 'zod';

let openaiClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
    });
  }
  return openaiClient;
}

export interface LLMCallOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Call LLM with JSON-only response, validate with Zod, retry once on invalid JSON
 */
export async function callLLMWithJsonValidation<T>(
  options: LLMCallOptions,
  schema: ZodSchema<T>,
  retries = 1
): Promise<T> {
  const client = getOpenAIClient();

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: options.userPrompt },
  ];

  let lastResponse = '';
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: config.openaiModel,
        messages,
        temperature: options.temperature ?? config.openaiTemperature,
        max_tokens: options.maxTokens ?? config.openaiMaxOutputTokens,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      lastResponse = content;

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (jsonError) {
        throw new Error(`Invalid JSON from LLM: ${jsonError}`);
      }

      // Validate with Zod
      const validated = schema.parse(parsed);
      return validated;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < retries) {
        console.warn(`LLM response validation failed (attempt ${attempt + 1}), retrying with fix prompt...`);

        // Add fix prompt for retry
        if (lastResponse) {
          messages.push({
            role: 'assistant',
            content: lastResponse,
          });
          messages.push({
            role: 'user',
            content: `Your previous response was invalid JSON or did not match the expected schema. Error: ${lastError.message}\n\nFix to valid JSON only. Return ONLY the corrected JSON object, nothing else.`,
          });
        }
      }
    }
  }

  throw lastError || new Error('LLM call failed after retries');
}

/**
 * Raw LLM call without validation (for debugging)
 */
export async function callLLMRaw(options: LLMCallOptions): Promise<string> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt },
    ],
    temperature: options.temperature ?? config.openaiTemperature,
    max_tokens: options.maxTokens ?? config.openaiMaxOutputTokens,
    response_format: { type: 'json_object' },
  });

  return response.choices[0]?.message?.content || '';
}
