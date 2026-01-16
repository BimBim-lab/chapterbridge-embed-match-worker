# ChapterBridge Embed/Match Worker

A Node.js + TypeScript worker for generating embeddings, matching segments across editions, and deriving cross-media mappings.

## Features

1. **Embedding Generation** - Creates 3 embeddings per segment (summary, events, entities)
2. **Per-Event Embeddings** - Creates individual embeddings for each event (up to 8 per segment)
3. **Segment Matching** - Matches segments between editions using vector similarity
4. **Monotonic Alignment** - Production-recommended matching with sequential constraints
5. **Event Voting** - Alternative matching using per-event similarity voting
6. **Cross-Media Derivation** - Derives mappings between media types (e.g., anime to manhwa) via a shared novel pivot

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Database Migration

Run the migration to create the `segment_event_embeddings` table:

```bash
psql $SUPABASE_DB_URL -f migrations/001_segment_event_embeddings.sql
```

### 3. Configure Environment

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

### 1. Generate Summary/Entities Embeddings

Generate embeddings (summary, events, entities) for segments in an edition:

```bash
npm run embed -- --editionId=<uuid> --limit=5000
```

### 2. Generate Per-Event Embeddings (NEW)

Generate individual embeddings for each event in a segment (up to 8 events per segment):

```bash
npm run embed-events -- --editionId=<uuid> --limit=5000
```

This stores embeddings in the `segment_event_embeddings` table for use with event voting matching.

### 3. Match Segments (Independent)

Match segments from one edition to another without ordering constraints:

```bash
npm run match -- --fromEditionId=<uuid> --toEditionId=<uuid> --limit=2000
```

### 4. Match with Monotonic Alignment

Production-recommended matching that enforces sequential ordering using summary/entities:

```bash
npm run match-align -- --fromEditionId=<uuid> --toEditionId=<uuid> --window=80 --backtrack=3 --limit=999999
```

Parameters:
- `--window`: How far ahead to search (default: 80)
- `--backtrack`: How far back to allow (default: 3)

### 5. Match with Event Voting (NEW)

Alternative matching algorithm that uses per-event similarity voting:

```bash
npm run match-events -- --fromEditionId=<uuid> --toEditionId=<uuid> --window=80 --backtrack=3 --limit=999999
```

**When to use event voting:**
- When segments have many distinct events that should match individually
- When summary-based matching produces poor results
- For fine-grained alignment where individual plot points matter

**How it works:**
1. For each source segment, fetch all its event embeddings
2. For each event, search for similar events in the target edition
3. Accumulate similarity votes per target segment number
4. Normalize by event count to get average similarity
5. Select best target chapter(s) within 0.02 of top score

### 6. Derive Cross-Media Mapping

Derive mappings between media types (e.g., anime to manhwa) using a shared novel as pivot:

```bash
npm run derive -- --fromEditionId=<animeId> --toEditionId=<manhwaId> --pivotEditionId=<novelId> --limit=999999
```

## Database Tables

### Core Tables (existing)

- `segments` - Chapter/episode records
- `segment_summaries` - AI-generated summaries and events
- `segment_entities` - Extracted characters, locations, keywords
- `segment_embeddings` - Summary/entities vector embeddings
- `segment_mappings` - Cross-edition mappings (output)

### New Table: segment_event_embeddings

Stores per-event embeddings for fine-grained matching:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| segment_id | UUID | Foreign key to segments |
| edition_id | UUID | Foreign key to editions (for windowed queries) |
| segment_number | INTEGER | Copied from segments.number for fast filtering |
| event_idx | INTEGER | Index of event in segment (0-based) |
| event_text | TEXT | The event text that was embedded |
| embedding | VECTOR(1536) | The embedding vector |
| embed_model | TEXT | Model used (default: text-embedding-3-small) |
| embed_dim | INTEGER | Dimension (default: 1536) |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update timestamp |

**Indexes:**
- Unique constraint on `(segment_id, event_idx)`
- Index on `(edition_id, segment_number)` for windowed queries
- IVFFlat index on `embedding` for cosine similarity search

## Algorithm Details

### Summary/Entities Scoring Weights

```
sim_summary_combo = 0.6 * sim(summary) + 0.4 * sim(events)
final_score = 0.8 * sim_summary_combo + 0.2 * sim(entities)
```

### Event Voting Algorithm

```
For each source segment:
  1. Get all event embeddings (up to 8)
  2. For each event embedding:
     - Find top-K similar events in target edition
     - Add similarity score to each target segment's vote total
  3. Compute average similarity per target segment:
     avg_similarity = total_votes / event_count
  4. Select best segment(s) within 0.02 of top average
```

### Time Context Adjustments (summary/entities only)

- Exact match: +0.02
- Clear mismatch (present vs flashback/future): -0.03
- Unknown/mixed: 0

### Range Mapping

Top candidates within 0.02 of the best score are grouped into a segment range.

## Project Structure

```
src/
  cli.ts        - CLI entry point
  config.ts     - Environment configuration
  supabase.ts   - Supabase client
  db.ts         - PostgreSQL connection (for pgvector)
  openai.ts     - OpenAI embedding API
  text.ts       - Text building utilities
  score.ts      - Scoring and overlap functions
  embed.ts      - Summary/entities embedding generation
  eventEmbed.ts - Per-event embedding generation (NEW)
  match.ts      - Independent matching
  align.ts      - Monotonic alignment matching
  eventMatch.ts - Event voting matching (NEW)
  derive.ts     - Cross-media derivation
migrations/
  001_segment_event_embeddings.sql - Database migration
```

## Build

```bash
npm run build
```

This compiles TypeScript to the `dist/` directory.
