# ChapterBridge Embed/Match Worker

A Node.js + TypeScript worker for generating embeddings, matching segments across editions, and deriving cross-media mappings.

## Features

1. **Embedding Generation** - Creates 3 embeddings per segment (summary, events, entities)
2. **Segment Matching** - Matches segments between editions using vector similarity
3. **Monotonic Alignment** - Production-recommended matching with sequential constraints
4. **Cross-Media Derivation** - Derives mappings between media types (e.g., anime to manhwa) via a shared novel pivot

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file with the following variables:

```env
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
SUPABASE_DB_URL=postgresql://postgres:password@host:5432/postgres
OPENAI_API_KEY=sk-your-openai-key

# Optional (defaults shown)
EMBED_MODEL=text-embedding-3-small
EMBED_DIM=1536
BATCH_SIZE=50
TOP_K=20
ALGO_VERSION=emb-v1
WINDOW=80
BACKTRACK=3
```

## Commands

### 1. Generate Embeddings

Generate 3 embeddings (summary, events, entities) for segments in an edition:

```bash
npm run embed -- --editionId=<uuid> --limit=5000
```

### 2. Match Segments (Independent)

Match segments from one edition to another without ordering constraints:

```bash
npm run match -- --fromEditionId=<uuid> --toEditionId=<uuid> --limit=2000
```

### 3. Match with Monotonic Alignment (Recommended)

Production-recommended matching that enforces sequential ordering:

```bash
npm run match-align -- --fromEditionId=<uuid> --toEditionId=<uuid> --window=80 --backtrack=3 --limit=999999
```

Parameters:
- `--window`: How far ahead to search (default: 80)
- `--backtrack`: How far back to allow (default: 3)

### 4. Derive Cross-Media Mapping

Derive mappings between media types (e.g., anime to manhwa) using a shared novel as pivot:

```bash
npm run derive -- --fromEditionId=<animeId> --toEditionId=<manhwaId> --pivotEditionId=<novelId> --limit=999999
```

## Database Tables Used

- `segments` - Chapter/episode records
- `segment_summaries` - AI-generated summaries and events
- `segment_entities` - Extracted characters, locations, keywords
- `segment_embeddings` - Vector embeddings (created by this worker)
- `segment_mappings` - Cross-edition mappings (created by this worker)

## Algorithm Details

### Scoring Weights

```
sim_summary_combo = 0.6 * sim(summary) + 0.4 * sim(events)
final_score = 0.8 * sim_summary_combo + 0.2 * sim(entities)
```

### Time Context Adjustments

- Exact match: +0.02
- Clear mismatch (present vs flashback/future): -0.03
- Unknown/mixed: 0

### Range Mapping

Top candidates within 0.02 of the best score are grouped into a segment range.

## Project Structure

```
src/
  cli.ts      - CLI entry point
  config.ts   - Environment configuration
  supabase.ts - Supabase client
  db.ts       - PostgreSQL connection (for pgvector)
  openai.ts   - OpenAI embedding API
  text.ts     - Text building utilities
  score.ts    - Scoring and overlap functions
  embed.ts    - Embedding generation
  match.ts    - Independent matching
  align.ts    - Monotonic alignment matching
  derive.ts   - Cross-media derivation
```

## Build

```bash
npm run build
```

This compiles TypeScript to the `dist/` directory.
