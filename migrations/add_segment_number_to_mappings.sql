-- Migration: Add segment_number column to segment_mappings table
-- Date: 2026-01-16

-- Add the segment_number column (allow NULL initially)
ALTER TABLE segment_mappings 
ADD COLUMN IF NOT EXISTS segment_number INTEGER;

-- Populate segment_number from segments table
UPDATE segment_mappings sm
SET segment_number = s.number
FROM segments s
WHERE sm.from_segment_id = s.id
  AND sm.segment_number IS NULL;

-- Make segment_number NOT NULL after population
ALTER TABLE segment_mappings 
ALTER COLUMN segment_number SET NOT NULL;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_segment_mappings_segment_number 
ON segment_mappings(segment_number);

-- Verification query
SELECT 
  COUNT(*) as total_mappings,
  COUNT(segment_number) as with_segment_number,
  COUNT(*) - COUNT(segment_number) as missing_segment_number
FROM segment_mappings;
