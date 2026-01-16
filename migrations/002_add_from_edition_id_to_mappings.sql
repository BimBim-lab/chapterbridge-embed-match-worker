-- Migration: Add from_edition_id to segment_mappings for easier querying
-- This allows direct filtering without joining through segments table

-- Add the column (nullable first for existing data)
ALTER TABLE segment_mappings 
ADD COLUMN IF NOT EXISTS from_edition_id UUID;

-- Backfill existing data
UPDATE segment_mappings sm
SET from_edition_id = s.edition_id
FROM segments s
WHERE sm.from_segment_id = s.id
AND sm.from_edition_id IS NULL;

-- Add NOT NULL constraint after backfill
ALTER TABLE segment_mappings 
ALTER COLUMN from_edition_id SET NOT NULL;

-- Add index for query performance
CREATE INDEX IF NOT EXISTS idx_segment_mappings_from_edition_to_edition 
ON segment_mappings(from_edition_id, to_edition_id);

-- Add index for checkpoint queries
CREATE INDEX IF NOT EXISTS idx_segment_mappings_from_edition_number 
ON segment_mappings(from_edition_id, segment_number DESC);

-- Comment
COMMENT ON COLUMN segment_mappings.from_edition_id IS 
'Edition ID of the source segment (denormalized from segments table for query performance)';
