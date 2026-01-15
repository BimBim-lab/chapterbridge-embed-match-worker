import 'dotenv/config';

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  supabaseDbUrl: process.env.SUPABASE_DB_URL || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  embedModel: process.env.EMBED_MODEL || 'text-embedding-3-small',
  embedDim: parseInt(process.env.EMBED_DIM || '1536', 10),
  batchSize: parseInt(process.env.BATCH_SIZE || '50', 10),
  topK: parseInt(process.env.TOP_K || '20', 10),
  algoVersion: process.env.ALGO_VERSION || 'emb-v1',
  window: parseInt(process.env.WINDOW || '80', 10),
  backtrack: parseInt(process.env.BACKTRACK || '3', 10),
};

export function validateConfig(required: (keyof typeof config)[]): void {
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
