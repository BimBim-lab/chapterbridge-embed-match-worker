-- Migration: Add segment_event_embeddings table for per-event embeddings
-- This migration is idempotent (safe to run multiple times)

CREATE TABLE IF NOT EXISTS segment_event_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  edition_id UUID NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  segment_number INTEGER NOT NULL,
  event_idx INTEGER NOT NULL,
  event_text TEXT NOT NULL,
  embedding VECTOR(1536),
  embed_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embed_dim INTEGER NOT NULL DEFAULT 1536,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_segment_event_embeddings_segment_event UNIQUE (segment_id, event_idx)
);

CREATE INDEX IF NOT EXISTS idx_segment_event_embeddings_edition_number 
  ON segment_event_embeddings(edition_id, segment_number);

CREATE INDEX IF NOT EXISTS idx_segment_event_embeddings_segment 
  ON segment_event_embeddings(segment_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_evt_emb_ivfflat'
  ) THEN
    CREATE INDEX idx_evt_emb_ivfflat 
      ON segment_event_embeddings 
      USING ivfflat (embedding vector_cosine_ops) 
      WITH (lists = 100);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION update_segment_event_embeddings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_segment_event_embeddings_updated_at ON segment_event_embeddings;

CREATE TRIGGER update_segment_event_embeddings_updated_at
  BEFORE UPDATE ON segment_event_embeddings
  FOR EACH ROW EXECUTE FUNCTION update_segment_event_embeddings_updated_at();
