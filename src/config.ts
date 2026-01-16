import 'dotenv/config';

export const config = {
  // Supabase
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  supabaseDbUrl: process.env.SUPABASE_DB_URL || '',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1',
  openaiTemperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0'),
  openaiMaxOutputTokens: parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || '4096', 10),

  // Legacy embedding config (for existing commands)
  embedModel: process.env.EMBED_MODEL || 'text-embedding-3-small',
  embedDim: parseInt(process.env.EMBED_DIM || '1536', 10),
  batchSize: parseInt(process.env.BATCH_SIZE || '50', 10),
  topK: parseInt(process.env.TOP_K || '20', 10),

  // Window settings for incremental matching
  windowSize: parseInt(process.env.WINDOW_SIZE || '70', 10),
  windowBefore: parseInt(process.env.WINDOW_BEFORE || '25', 10),
  windowAfter: parseInt(process.env.WINDOW_AFTER || '45', 10),
  maxWindowSize: parseInt(process.env.MAX_WINDOW_SIZE || '200', 10),

  // Matching thresholds
  minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.55'),

  // Algorithm version
  algoVersion: process.env.ALGO_VERSION || 'llm-gpt4.1-events-v1',

  // Fallback settings
  enableFallback: process.env.ENABLE_FALLBACK === 'true',
  fallbackWindowSize: parseInt(process.env.FALLBACK_WINDOW_SIZE || '40', 10),
  fallbackConfidencePenalty: parseFloat(process.env.FALLBACK_CONFIDENCE_PENALTY || '0.6'),

  // Legacy settings
  window: parseInt(process.env.WINDOW || '80', 10),
  backtrack: parseInt(process.env.BACKTRACK || '3', 10),
};

export function validateConfig(required: (keyof typeof config)[]): void {
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
