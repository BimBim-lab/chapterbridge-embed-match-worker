import OpenAI from 'openai';
import { config } from './config.js';

let openai: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return openai;
}

export async function createEmbedding(text: string, retries = 3): Promise<number[]> {
  const client = getOpenAI();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await client.embeddings.create({
        model: config.embedModel,
        input: text,
        dimensions: config.embedDim,
      });
      return response.data[0].embedding;
    } catch (error: any) {
      lastError = error;
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`Embedding attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError || new Error('Failed to create embedding');
}

export async function createEmbeddingsBatch(
  texts: string[],
  retries = 3
): Promise<number[][]> {
  const client = getOpenAI();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await client.embeddings.create({
        model: config.embedModel,
        input: texts,
        dimensions: config.embedDim,
      });
      return response.data.map((d) => d.embedding);
    } catch (error: any) {
      lastError = error;
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`Batch embedding attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError || new Error('Failed to create embeddings batch');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
