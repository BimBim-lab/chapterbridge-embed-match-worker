import { query } from './db.js';

interface PivotMapping {
  from_segment_id: string;
  from_segment_number: number;
  to_segment_start: number;
  to_segment_end: number;
  confidence: number;
}

interface ManhwaMapping {
  manhwa_segment_id: string;
  manhwa_segment_number: number;
  pivot_start: number;
  pivot_end: number;
  confidence: number;
}

export async function runDerive(
  fromEditionId: string,
  toEditionId: string,
  pivotEditionId: string,
  limit: number
): Promise<void> {
  console.log(
    `Deriving cross-media mapping: ${fromEditionId} -> ${toEditionId} via pivot ${pivotEditionId}, limit: ${limit}`
  );

  const animeToPivot = await fetchMappingsToPivot(fromEditionId, pivotEditionId, limit);
  console.log(`Found ${animeToPivot.length} anime->pivot mappings`);

  const manhwaToPivot = await fetchManhwaMappingsToPivot(toEditionId, pivotEditionId);
  console.log(`Found ${manhwaToPivot.length} manhwa->pivot mappings`);

  if (animeToPivot.length === 0 || manhwaToPivot.length === 0) {
    console.log('Missing pivot mappings, cannot derive');
    return;
  }

  let processed = 0;
  let errors = 0;
  let derived = 0;

  for (const animeMapping of animeToPivot) {
    try {
      const result = await deriveMapping(
        animeMapping,
        manhwaToPivot,
        toEditionId,
        pivotEditionId
      );
      if (result) derived++;
      processed++;
      if (processed % 10 === 0 || processed === animeToPivot.length) {
        console.log(
          `Progress: ${processed}/${animeToPivot.length}, derived: ${derived} (${errors} errors)`
        );
      }
    } catch (error) {
      errors++;
      console.error(`Error deriving for segment ${animeMapping.from_segment_id}:`, error);
    }
  }

  console.log(`Derivation complete. Processed: ${processed}, Derived: ${derived}, Errors: ${errors}`);
}

async function fetchMappingsToPivot(
  fromEditionId: string,
  pivotEditionId: string,
  limit: number
): Promise<PivotMapping[]> {
  const sql = `
    SELECT 
      sm.from_segment_id,
      s.number AS from_segment_number,
      sm.to_segment_start,
      sm.to_segment_end,
      sm.confidence
    FROM segment_mappings sm
    JOIN segments s ON s.id = sm.from_segment_id
    WHERE s.edition_id = $1 AND sm.to_edition_id = $2
    ORDER BY s.number ASC
    LIMIT $3
  `;

  return query<PivotMapping>(sql, [fromEditionId, pivotEditionId, limit]);
}

async function fetchManhwaMappingsToPivot(
  manhwaEditionId: string,
  pivotEditionId: string
): Promise<ManhwaMapping[]> {
  const sql = `
    SELECT 
      sm.from_segment_id AS manhwa_segment_id,
      s.number AS manhwa_segment_number,
      sm.to_segment_start AS pivot_start,
      sm.to_segment_end AS pivot_end,
      sm.confidence
    FROM segment_mappings sm
    JOIN segments s ON s.id = sm.from_segment_id
    WHERE s.edition_id = $1 AND sm.to_edition_id = $2
    ORDER BY s.number ASC
  `;

  return query<ManhwaMapping>(sql, [manhwaEditionId, pivotEditionId]);
}

async function deriveMapping(
  animeMapping: PivotMapping,
  manhwaMappings: ManhwaMapping[],
  toEditionId: string,
  pivotEditionId: string
): Promise<boolean> {
  const aStart = animeMapping.to_segment_start;
  const aEnd = animeMapping.to_segment_end;
  const confA = animeMapping.confidence;
  const lenA = aEnd - aStart + 1;

  const overlappingManhwa: Array<{
    mapping: ManhwaMapping;
    overlapLen: number;
    overlapRatio: number;
    derivedConf: number;
  }> = [];

  for (const mMapping of manhwaMappings) {
    const mStart = mMapping.pivot_start;
    const mEnd = mMapping.pivot_end;
    const confM = mMapping.confidence;
    const lenM = mEnd - mStart + 1;

    const overlapLen = Math.max(0, Math.min(aEnd, mEnd) - Math.max(aStart, mStart) + 1);

    if (overlapLen > 0) {
      const overlapRatio = overlapLen / Math.min(lenA, lenM);
      const derivedConf = Math.min(1, Math.max(0, confA * confM * overlapRatio));

      overlappingManhwa.push({
        mapping: mMapping,
        overlapLen,
        overlapRatio,
        derivedConf,
      });
    }
  }

  if (overlappingManhwa.length === 0) {
    return false;
  }

  overlappingManhwa.sort((a, b) => b.derivedConf - a.derivedConf);

  const best = overlappingManhwa[0];
  const threshold = best.derivedConf - 0.05;
  const topCandidates = overlappingManhwa.filter((o) => o.derivedConf >= threshold);

  const numbers = topCandidates.map((t) => t.mapping.manhwa_segment_number);
  const toSegmentStart = Math.min(...numbers);
  const toSegmentEnd = Math.max(...numbers);
  const confidence = best.derivedConf;

  const evidence = {
    pivot_edition_id: pivotEditionId,
    anime_to_pivot: {
      start: aStart,
      end: aEnd,
      confidence: confA,
    },
    best_manhwa_to_pivot: topCandidates.slice(0, 5).map((t) => ({
      manhwa_segment_id: t.mapping.manhwa_segment_id,
      range: [t.mapping.pivot_start, t.mapping.pivot_end],
      confidence: t.mapping.confidence,
    })),
    overlap: {
      len: best.overlapLen,
      ratio: best.overlapRatio,
    },
    derived_conf: confidence,
  };

  await upsertDerivedMapping(
    animeMapping.from_segment_id,
    toEditionId,
    toSegmentStart,
    toSegmentEnd,
    confidence,
    evidence
  );

  return true;
}

async function upsertDerivedMapping(
  fromSegmentId: string,
  toEditionId: string,
  toSegmentStart: number,
  toSegmentEnd: number,
  confidence: number,
  evidence: any
): Promise<void> {
  const sql = `
    INSERT INTO segment_mappings (
      from_segment_id, to_edition_id, to_segment_start, to_segment_end,
      confidence, evidence, status, algorithm_version
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'proposed', 'derived-v1')
    ON CONFLICT (from_segment_id, to_edition_id) DO UPDATE SET
      to_segment_start = EXCLUDED.to_segment_start,
      to_segment_end = EXCLUDED.to_segment_end,
      confidence = EXCLUDED.confidence,
      evidence = EXCLUDED.evidence,
      status = EXCLUDED.status,
      algorithm_version = EXCLUDED.algorithm_version,
      updated_at = NOW()
  `;

  await query(sql, [
    fromSegmentId,
    toEditionId,
    toSegmentStart,
    toSegmentEnd,
    confidence,
    JSON.stringify(evidence),
  ]);
}
