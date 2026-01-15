import { query } from './db.js';
import { config } from './config.js';
import {
  computeFinalScore,
  applyTimeContextAdjustment,
  computeEntityOverlap,
} from './score.js';

interface FromSegment {
  segment_id: string;
  segment_number: number;
  time_context: string;
  embedding_summary: number[] | null;
  embedding_events: number[] | null;
  embedding_entities: number[] | null;
  characters: any[];
  locations: any[];
  keywords: any[];
}

interface Candidate {
  segment_id: string;
  number: number;
  sim_summary: number;
  sim_events: number;
  sim_entities: number;
  time_context: string;
  characters: any[];
  locations: any[];
  keywords: any[];
  final_score?: number;
}

export async function runMatchAlign(
  fromEditionId: string,
  toEditionId: string,
  windowSize: number,
  backtrack: number,
  limit: number
): Promise<void> {
  console.log(
    `Starting monotonic alignment: ${fromEditionId} -> ${toEditionId}, window: ${windowSize}, backtrack: ${backtrack}, limit: ${limit}`
  );

  const fromSegments = await fetchFromSegments(fromEditionId, limit);
  console.log(`Found ${fromSegments.length} source segments`);

  if (fromSegments.length === 0) {
    console.log('No segments to align');
    return;
  }

  let lastBestToNumber: number | null = null;
  let processed = 0;
  let errors = 0;

  for (const fromSeg of fromSegments) {
    try {
      const result = await alignSegment(
        fromSeg,
        toEditionId,
        lastBestToNumber,
        windowSize,
        backtrack
      );

      if (result) {
        const midpoint = Math.floor((result.toSegmentStart + result.toSegmentEnd) / 2);
        lastBestToNumber = midpoint;
      }

      processed++;
      if (processed % 10 === 0 || processed === fromSegments.length) {
        console.log(
          `Progress: ${processed}/${fromSegments.length}, lastBestToNumber: ${lastBestToNumber} (${errors} errors)`
        );
      }
    } catch (error) {
      errors++;
      console.error(`Error aligning segment ${fromSeg.segment_id}:`, error);
    }
  }

  console.log(`Alignment complete. Processed: ${processed}, Errors: ${errors}`);
}

async function fetchFromSegments(
  editionId: string,
  limit: number
): Promise<FromSegment[]> {
  const sql = `
    SELECT 
      s.id AS segment_id,
      s.number AS segment_number,
      se.time_context,
      emb.embedding_summary,
      emb.embedding_events,
      emb.embedding_entities,
      se.characters,
      se.locations,
      se.keywords
    FROM segments s
    JOIN segment_embeddings emb ON emb.segment_id = s.id
    JOIN segment_entities se ON se.segment_id = s.id
    WHERE s.edition_id = $1
    ORDER BY s.number ASC
    LIMIT $2
  `;

  return query<FromSegment>(sql, [editionId, limit]);
}

async function alignSegment(
  fromSeg: FromSegment,
  toEditionId: string,
  lastBestToNumber: number | null,
  windowSize: number,
  backtrack: number
): Promise<{ toSegmentStart: number; toSegmentEnd: number; confidence: number } | null> {
  let minNumber: number | undefined;
  let maxNumber: number | undefined;

  if (lastBestToNumber !== null) {
    minNumber = lastBestToNumber - backtrack;
    maxNumber = lastBestToNumber + windowSize;
  }

  const candidates = await fetchCandidates(fromSeg, toEditionId, minNumber, maxNumber);

  if (candidates.length === 0) {
    return null;
  }

  for (const cand of candidates) {
    cand.final_score = computeFinalScore(
      cand.sim_summary,
      cand.sim_events,
      cand.sim_entities
    );
    cand.final_score = applyTimeContextAdjustment(
      cand.final_score,
      fromSeg.time_context,
      cand.time_context
    );

    if (lastBestToNumber !== null && cand.number < lastBestToNumber - backtrack) {
      cand.final_score -= 0.01;
    }
  }

  candidates.sort((a, b) => (b.final_score || 0) - (a.final_score || 0));

  const top = candidates[0];
  const threshold = (top.final_score || 0) - 0.02;
  const inRange = candidates.filter((c) => (c.final_score || 0) >= threshold);

  const numbers = inRange.map((c) => c.number);
  const toSegmentStart = Math.min(...numbers);
  const toSegmentEnd = Math.max(...numbers);
  const confidence = top.final_score || 0;

  const overlap = computeEntityOverlap(
    { characters: fromSeg.characters, locations: fromSeg.locations, keywords: fromSeg.keywords },
    { characters: top.characters, locations: top.locations, keywords: top.keywords }
  );

  const evidence = {
    scores: {
      sim_sum: top.sim_summary,
      sim_evt: top.sim_events,
      sim_ent: top.sim_entities,
      final: top.final_score,
    },
    time_context: {
      from: fromSeg.time_context,
      to: top.time_context,
    },
    overlap,
    top_candidates: candidates.slice(0, 5).map((c) => ({
      segment_id: c.segment_id,
      number: c.number,
      final: c.final_score,
    })),
    alignment: {
      last_best_to_number: lastBestToNumber,
      window_min: minNumber,
      window_max: maxNumber,
    },
  };

  const algoVersion = `${config.algoVersion}-align`;

  await upsertMapping(
    fromSeg.segment_id,
    toEditionId,
    toSegmentStart,
    toSegmentEnd,
    confidence,
    evidence,
    algoVersion
  );

  return { toSegmentStart, toSegmentEnd, confidence };
}

async function fetchCandidates(
  fromSeg: FromSegment,
  toEditionId: string,
  minNumber?: number,
  maxNumber?: number
): Promise<Candidate[]> {
  const rangeClause =
    minNumber !== undefined && maxNumber !== undefined
      ? `AND s.number BETWEEN ${minNumber} AND ${maxNumber}`
      : '';

  const candidateMap = new Map<string, Candidate>();

  if (fromSeg.embedding_summary) {
    const sql = `
      SELECT 
        se.segment_id, s.number,
        1 - (se.embedding_summary <=> $1) AS sim,
        ent.time_context, ent.characters, ent.locations, ent.keywords
      FROM segment_embeddings se
      JOIN segments s ON s.id = se.segment_id
      JOIN segment_entities ent ON ent.segment_id = s.id
      WHERE s.edition_id = $2 AND se.embedding_summary IS NOT NULL ${rangeClause}
      ORDER BY se.embedding_summary <=> $1
      LIMIT $3
    `;
    const rows = await query<any>(sql, [
      `[${fromSeg.embedding_summary.join(',')}]`,
      toEditionId,
      config.topK,
    ]);
    for (const r of rows) {
      if (!candidateMap.has(r.segment_id)) {
        candidateMap.set(r.segment_id, {
          segment_id: r.segment_id,
          number: parseFloat(r.number),
          sim_summary: r.sim || 0,
          sim_events: 0,
          sim_entities: 0,
          time_context: r.time_context,
          characters: r.characters || [],
          locations: r.locations || [],
          keywords: r.keywords || [],
        });
      } else {
        candidateMap.get(r.segment_id)!.sim_summary = r.sim || 0;
      }
    }
  }

  if (fromSeg.embedding_events) {
    const sql = `
      SELECT 
        se.segment_id, s.number,
        1 - (se.embedding_events <=> $1) AS sim,
        ent.time_context, ent.characters, ent.locations, ent.keywords
      FROM segment_embeddings se
      JOIN segments s ON s.id = se.segment_id
      JOIN segment_entities ent ON ent.segment_id = s.id
      WHERE s.edition_id = $2 AND se.embedding_events IS NOT NULL ${rangeClause}
      ORDER BY se.embedding_events <=> $1
      LIMIT $3
    `;
    const rows = await query<any>(sql, [
      `[${fromSeg.embedding_events.join(',')}]`,
      toEditionId,
      config.topK,
    ]);
    for (const r of rows) {
      if (!candidateMap.has(r.segment_id)) {
        candidateMap.set(r.segment_id, {
          segment_id: r.segment_id,
          number: parseFloat(r.number),
          sim_summary: 0,
          sim_events: r.sim || 0,
          sim_entities: 0,
          time_context: r.time_context,
          characters: r.characters || [],
          locations: r.locations || [],
          keywords: r.keywords || [],
        });
      } else {
        candidateMap.get(r.segment_id)!.sim_events = r.sim || 0;
      }
    }
  }

  if (fromSeg.embedding_entities) {
    const sql = `
      SELECT 
        se.segment_id, s.number,
        1 - (se.embedding_entities <=> $1) AS sim,
        ent.time_context, ent.characters, ent.locations, ent.keywords
      FROM segment_embeddings se
      JOIN segments s ON s.id = se.segment_id
      JOIN segment_entities ent ON ent.segment_id = s.id
      WHERE s.edition_id = $2 AND se.embedding_entities IS NOT NULL ${rangeClause}
      ORDER BY se.embedding_entities <=> $1
      LIMIT $3
    `;
    const rows = await query<any>(sql, [
      `[${fromSeg.embedding_entities.join(',')}]`,
      toEditionId,
      config.topK,
    ]);
    for (const r of rows) {
      if (!candidateMap.has(r.segment_id)) {
        candidateMap.set(r.segment_id, {
          segment_id: r.segment_id,
          number: parseFloat(r.number),
          sim_summary: 0,
          sim_events: 0,
          sim_entities: r.sim || 0,
          time_context: r.time_context,
          characters: r.characters || [],
          locations: r.locations || [],
          keywords: r.keywords || [],
        });
      } else {
        candidateMap.get(r.segment_id)!.sim_entities = r.sim || 0;
      }
    }
  }

  return Array.from(candidateMap.values());
}

async function upsertMapping(
  fromSegmentId: string,
  toEditionId: string,
  toSegmentStart: number,
  toSegmentEnd: number,
  confidence: number,
  evidence: any,
  algoVersion: string
): Promise<void> {
  const sql = `
    INSERT INTO segment_mappings (
      from_segment_id, to_edition_id, to_segment_start, to_segment_end,
      confidence, evidence, status, algorithm_version
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7)
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
    algoVersion,
  ]);
}
