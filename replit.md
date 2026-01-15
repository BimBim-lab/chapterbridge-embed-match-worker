# ChapterBridge Embed/Match Worker

## Overview

A Node.js + TypeScript CLI worker for the ChapterBridge pipeline. Handles embedding generation, segment matching, and cross-media mapping derivation.

## Project Structure

```
src/
  cli.ts      - CLI entry point with command routing
  config.ts   - Environment configuration loader
  supabase.ts - Supabase client wrapper
  db.ts       - PostgreSQL connection pool (for pgvector queries)
  openai.ts   - OpenAI embedding API with retry logic
  text.ts     - Text building utilities for embeddings
  score.ts    - Scoring, overlap, and time context functions
  embed.ts    - Embedding generation (3 per segment)
  match.ts    - Independent segment matching
  align.ts    - Monotonic alignment matching
  derive.ts   - Cross-media derivation via pivot
```

## Commands

- `npm run embed` - Generate embeddings for edition
- `npm run match` - Independent segment matching
- `npm run match-align` - Monotonic alignment matching (production)
- `npm run derive` - Derive cross-media mappings via pivot

## Environment Variables

Required:
- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- SUPABASE_DB_URL
- OPENAI_API_KEY

Optional:
- EMBED_MODEL (default: text-embedding-3-small)
- EMBED_DIM (default: 1536)
- BATCH_SIZE (default: 50)
- TOP_K (default: 20)
- ALGO_VERSION (default: emb-v1)
- WINDOW (default: 80)
- BACKTRACK (default: 3)

## Database Tables

Uses Supabase Postgres with pgvector extension:
- segments, segment_summaries, segment_entities
- segment_embeddings (writes)
- segment_mappings (writes)

## Recent Changes

- January 2026: Initial implementation with embed, match, match-align, derive commands
