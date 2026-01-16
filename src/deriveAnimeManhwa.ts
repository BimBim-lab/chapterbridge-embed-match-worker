import { query } from './db.js';
import { config } from './config.js';
import { buildDeriveEvidence } from './evidence.js';
import { clamp, formatConfidence, formatRange, overlapLength, overlapRatio } from './utils.js';

// ============================================================================
// INTERFACES
// ============================================================================

interface AnimeNovelMapping {
  from_segment_id: string;
  from_segment_number: number;
  to_segment_start: number;
  to_segment_end: number;
  confidence: number;
}

interface ManhwaNovelMapping {
  from_segment_id: string;
  from_segment_number: number;
  to_segment_start: number;
  to_segment_end: number;
  confidence: number;
}

interface DerivedMapping {
  anime_segment_id: string;
  anime_segment_number: number;
  manhwa_start: number;
  manhwa_end: number;
  derived_confidence: number;
  best_overlap_len: number;
  best_overlap_ratio: number;
  anime_novel_range: [number, number];
  best_manhwa_novel_range: [number, number];
  conf_anime: number;
  conf_manhwa: number;
}

// ============================================================================
// DATABASE QUERIES
// ============================================================================

async function fetchAnimeToNovelMappings(
  animeEditionId: string,
  novelEditionId: string
): Promise<AnimeNovelMapping[]> {
  const sql = `
    SELECT
      sm.from_segment_id,
      s.number::float as from_segment_number,
      sm.to_segment_start,
      sm.to_segment_end,
      sm.confidence
    FROM segment_mappings sm
    JOIN segments s ON s.id = sm.from_segment_id
    WHERE s.edition_id = $1 AND sm.to_edition_id = $2
    ORDER BY s.number ASC
  `;

  const rows = await query<{
    from_segment_id: string;
    from_segment_number: number;
    to_segment_start: number;
    to_segment_end: number;
    confidence: number;
  }>(sql, [animeEditionId, novelEditionId]);

  return rows.map((row) => ({
    from_segment_id: row.from_segment_id,
    from_segment_number: Math.floor(row.from_segment_number),
    to_segment_start: row.to_segment_start,
    to_segment_end: row.to_segment_end,
    confidence: row.confidence,
  }));
}

async function fetchManhwaToNovelMappings(
  manhwaEditionId: string,
  novelEditionId: string
): Promise<ManhwaNovelMapping[]> {
  const sql = `
    SELECT
      sm.from_segment_id,
      s.number::float as from_segment_number,
      sm.to_segment_start,
      sm.to_segment_end,
      sm.confidence
    FROM segment_mappings sm
    JOIN segments s ON s.id = sm.from_segment_id
    WHERE s.edition_id = $1 AND sm.to_edition_id = $2
    ORDER BY s.number ASC
  `;

  const rows = await query<{
    from_segment_id: string;
    from_segment_number: number;
    to_segment_start: number;
    to_segment_end: number;
    confidence: number;
  }>(sql, [manhwaEditionId, novelEditionId]);

  return rows.map((row) => ({
    from_segment_id: row.from_segment_id,
    from_segment_number: Math.floor(row.from_segment_number),
    to_segment_start: row.to_segment_start,
    to_segment_end: row.to_segment_end,
    confidence: row.confidence,
  }));
}

async function upsertDerivedMapping(
  fromSegmentId: string,
  fromEditionId: string,
  segmentNumber: number,
  toEditionId: string,
  toSegmentStart: number,
  toSegmentEnd: number,
  confidence: number,
  evidence: any,
  status: string
): Promise<void> {
  // Check if mapping exists
  const existingCheck = await query<{ id: string }>(
    `SELECT id FROM segment_mappings WHERE from_segment_id = $1 AND to_edition_id = $2`,
    [fromSegmentId, toEditionId]
  );

  if (existingCheck.length > 0) {
    // Update existing
    await query(
      `UPDATE segment_mappings SET
        from_edition_id = $1,
        segment_number = $2,
        to_segment_start = $3,
        to_segment_end = $4,
        confidence = $5,
        evidence = $6,
        status = $7,
        algorithm_version = 'derived-v1',
        updated_at = NOW()
      WHERE from_segment_id = $8 AND to_edition_id = $9`,
      [
        fromEditionId,
        segmentNumber,
        toSegmentStart,
        toSegmentEnd,
        confidence,
        JSON.stringify(evidence),
        status,
        fromSegmentId,
        toEditionId,
      ]
    );
  } else {
    // Insert new
    await query(
      `INSERT INTO segment_mappings (
        from_segment_id, from_edition_id, segment_number, to_edition_id,
        to_segment_start, to_segment_end, confidence,
        evidence, status, algorithm_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'derived-v1')`,
      [
        fromSegmentId,
        fromEditionId,
        segmentNumber,
        toEditionId,
        toSegmentStart,
        toSegmentEnd,
        confidence,
        JSON.stringify(evidence),
        status,
      ]
    );
  }
}

// ============================================================================
// DERIVATION LOGIC
// ============================================================================

function deriveAnimeManhwaMapping(
  animeMapping: AnimeNovelMapping,
  manhwaMappings: ManhwaNovelMapping[]
): DerivedMapping | null {
  const aStart = animeMapping.to_segment_start;
  const aEnd = animeMapping.to_segment_end;
  const confA = animeMapping.confidence;
  const lenA = aEnd - aStart + 1;

  // Find all overlapping manhwa mappings
  const overlapping: Array<{
    mapping: ManhwaNovelMapping;
    overlap: number;
    ratio: number;
    derivedConf: number;
  }> = [];

  for (const mMapping of manhwaMappings) {
    const mStart = mMapping.to_segment_start;
    const mEnd = mMapping.to_segment_end;
    const confM = mMapping.confidence;
    const lenM = mEnd - mStart + 1;

    const overlap = overlapLength(aStart, aEnd, mStart, mEnd);

    if (overlap > 0) {
      const ratio = overlapRatio(aStart, aEnd, mStart, mEnd);
      const derivedConf = clamp(confA * confM * ratio, 0, 1);

      overlapping.push({
        mapping: mMapping,
        overlap,
        ratio,
        derivedConf,
      });
    }
  }

  if (overlapping.length === 0) {
    return null;
  }

  // Sort by derived confidence
  overlapping.sort((a, b) => b.derivedConf - a.derivedConf);

  // Get best match(es) - include those within 0.05 of top
  const best = overlapping[0];
  const threshold = best.derivedConf - 0.05;
  const topMatches = overlapping.filter((o) => o.derivedConf >= threshold);

  // Compute contiguous manhwa range from top matches
  const manhwaNumbers = topMatches.map((t) => t.mapping.from_segment_number);
  manhwaNumbers.sort((a, b) => a - b);

  // Find contiguous range (allow gaps of 1)
  let manhwaStart = manhwaNumbers[0];
  let manhwaEnd = manhwaNumbers[0];
  for (let i = 1; i < manhwaNumbers.length; i++) {
    if (manhwaNumbers[i] - manhwaEnd <= 2) {
      manhwaEnd = manhwaNumbers[i];
    } else {
      break; // Stop at first large gap
    }
  }

  return {
    anime_segment_id: animeMapping.from_segment_id,
    anime_segment_number: animeMapping.from_segment_number,
    manhwa_start: manhwaStart,
    manhwa_end: manhwaEnd,
    derived_confidence: best.derivedConf,
    best_overlap_len: best.overlap,
    best_overlap_ratio: best.ratio,
    anime_novel_range: [aStart, aEnd],
    best_manhwa_novel_range: [best.mapping.to_segment_start, best.mapping.to_segment_end],
    conf_anime: confA,
    conf_manhwa: best.mapping.confidence,
  };
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export interface DeriveOptions {
  animeEditionId: string;
  manhwaEditionId: string;
  novelEditionId: string;
}

export async function runDeriveAnimeManhwa(options: DeriveOptions): Promise<void> {
  const { animeEditionId, manhwaEditionId, novelEditionId } = options;

  console.log('\n========================================');
  console.log('DERIVE: Anime -> Manhwa via Novel Pivot');
  console.log('========================================');
  console.log(`Anime Edition: ${animeEditionId}`);
  console.log(`Manhwa Edition: ${manhwaEditionId}`);
  console.log(`Novel Edition (pivot): ${novelEditionId}`);
  console.log('');

  // 1. Fetch anime->novel mappings
  console.log('Fetching anime->novel mappings...');
  const animeToNovel = await fetchAnimeToNovelMappings(animeEditionId, novelEditionId);
  console.log(`Found ${animeToNovel.length} anime->novel mappings`);

  // 2. Fetch manhwa->novel mappings
  console.log('Fetching manhwa->novel mappings...');
  const manhwaToNovel = await fetchManhwaToNovelMappings(manhwaEditionId, novelEditionId);
  console.log(`Found ${manhwaToNovel.length} manhwa->novel mappings`);

  if (animeToNovel.length === 0) {
    console.error('No anime->novel mappings found. Run match-all first.');
    return;
  }

  if (manhwaToNovel.length === 0) {
    console.error('No manhwa->novel mappings found. Run match-all first.');
    return;
  }

  // 3. Derive mappings
  console.log('\nDeriving anime->manhwa mappings...');
  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const animeMapping of animeToNovel) {
    const derived = deriveAnimeManhwaMapping(animeMapping, manhwaToNovel);

    if (!derived) {
      console.log(`  ep:${animeMapping.from_segment_number} -> [no overlap], skipping`);
      skippedCount++;
      continue;
    }

    // Determine status
    const status = derived.derived_confidence < config.minConfidence ? 'proposed' : 'approved';

    // Build evidence
    const evidence = buildDeriveEvidence(
      derived.anime_novel_range,
      derived.best_manhwa_novel_range,
      derived.best_overlap_len,
      derived.best_overlap_ratio,
      derived.conf_anime,
      derived.conf_manhwa,
      derived.derived_confidence
    );

    try {
      await upsertDerivedMapping(
        derived.anime_segment_id,
        animeEditionId,
        derived.anime_segment_number,
        manhwaEditionId,
        derived.manhwa_start,
        derived.manhwa_end,
        derived.derived_confidence,
        evidence,
        status
      );

      console.log(
        `  ep:${derived.anime_segment_number} -> ch:${formatRange(derived.manhwa_start, derived.manhwa_end)} ` +
        `conf=${formatConfidence(derived.derived_confidence)} status=${status}`
      );
      successCount++;
    } catch (error) {
      console.error(`  Error deriving for ep:${derived.anime_segment_number}:`, error);
      errorCount++;
    }
  }

  console.log('\n========================================');
  console.log('DERIVE COMPLETE');
  console.log('========================================');
  console.log(`Derived: ${successCount}`);
  console.log(`Skipped (no overlap): ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Algorithm: derived-v1`);
}
