import { query } from './db.js';
import { config } from './config.js';

interface FromSegmentEvents {
  segment_id: string;
  segment_number: number;
  event_embeddings: EventEmbedding[];
}

interface EventEmbedding {
  event_idx: number;
  embedding: number[];
}

interface SegmentVote {
  segment_number: number;
  total_similarity: number;
  vote_count: number;
  avg_similarity: number;
}

export async function runMatchEvents(
  fromEditionId: string,
  toEditionId: string,
  windowSize: number,
  backtrack: number,
  limit: number
): Promise<void> {
  console.log(
    `Starting event-based matching: ${fromEditionId} -> ${toEditionId}, window: ${windowSize}, backtrack: ${backtrack}, limit: ${limit}`
  );

  const fromSegments = await fetchFromSegmentsWithEvents(fromEditionId, limit);
  console.log(`Found ${fromSegments.length} source segments with event embeddings`);

  if (fromSegments.length === 0) {
    console.log('No segments with event embeddings to match');
    return;
  }

  let lastBestToNumber: number | null = null;
  let processed = 0;
  let matched = 0;
  let errors = 0;

  for (const fromSeg of fromSegments) {
    try {
      const result = await matchSegmentByEvents(
        fromSeg,
        toEditionId,
        lastBestToNumber,
        windowSize,
        backtrack
      );

      if (result) {
        matched++;
        const midpoint = Math.floor((result.toSegmentStart + result.toSegmentEnd) / 2);
        lastBestToNumber = midpoint;
      }

      processed++;
      if (processed % 10 === 0 || processed === fromSegments.length) {
        console.log(
          `Progress: ${processed}/${fromSegments.length}, matched: ${matched}, lastBest: ${lastBestToNumber} (${errors} errors)`
        );
      }
    } catch (error) {
      errors++;
      console.error(`Error matching segment ${fromSeg.segment_id}:`, error);
    }
  }

  console.log(
    `Event matching complete. Processed: ${processed}, Matched: ${matched}, Errors: ${errors}`
  );
}

async function fetchFromSegmentsWithEvents(
  editionId: string,
  limit: number
): Promise<FromSegmentEvents[]> {
  const sql = `
    SELECT 
      s.id AS segment_id,
      s.number AS segment_number,
      json_agg(
        json_build_object(
          'event_idx', see.event_idx,
          'embedding', see.embedding
        ) ORDER BY see.event_idx
      ) AS event_embeddings
    FROM segments s
    JOIN segment_event_embeddings see ON see.segment_id = s.id
    WHERE s.edition_id = $1 AND see.embedding IS NOT NULL
    GROUP BY s.id, s.number
    ORDER BY s.number ASC
    LIMIT $2
  `;

  const rows = await query<any>(sql, [editionId, limit]);
  return rows.map((r) => ({
    segment_id: r.segment_id,
    segment_number: parseFloat(r.segment_number),
    event_embeddings: r.event_embeddings || [],
  }));
}

async function matchSegmentByEvents(
  fromSeg: FromSegmentEvents,
  toEditionId: string,
  lastBestToNumber: number | null,
  windowSize: number,
  backtrack: number
): Promise<{ toSegmentStart: number; toSegmentEnd: number; confidence: number } | null> {
  if (fromSeg.event_embeddings.length === 0) {
    return null;
  }

  let minNumber: number | undefined;
  let maxNumber: number | undefined;

  if (lastBestToNumber !== null) {
    minNumber = lastBestToNumber - backtrack;
    maxNumber = lastBestToNumber + windowSize;
  }

  const votes = new Map<number, { total: number; count: number }>();

  for (const eventEmb of fromSeg.event_embeddings) {
    const candidates = await searchEventCandidates(
      eventEmb.embedding,
      toEditionId,
      minNumber,
      maxNumber,
      config.topK
    );

    for (const cand of candidates) {
      const existing = votes.get(cand.segment_number) || { total: 0, count: 0 };
      existing.total += cand.similarity;
      existing.count += 1;
      votes.set(cand.segment_number, existing);
    }
  }

  if (votes.size === 0) {
    return null;
  }

  const segmentVotes: SegmentVote[] = Array.from(votes.entries()).map(
    ([segNum, data]) => ({
      segment_number: segNum,
      total_similarity: data.total,
      vote_count: data.count,
      avg_similarity: data.total / data.count,
    })
  );

  segmentVotes.sort((a, b) => b.avg_similarity - a.avg_similarity);

  const top = segmentVotes[0];
  const threshold = top.avg_similarity - 0.02;
  const inRange = segmentVotes.filter((v) => v.avg_similarity >= threshold);

  const numbers = inRange.map((v) => v.segment_number);
  const toSegmentStart = Math.min(...numbers);
  const toSegmentEnd = Math.max(...numbers);
  const confidence = top.avg_similarity;

  const evidence = {
    algorithm: 'event-voting',
    from_event_count: fromSeg.event_embeddings.length,
    top_candidates: segmentVotes.slice(0, 5).map((v) => ({
      segment_number: v.segment_number,
      avg_similarity: v.avg_similarity,
      vote_count: v.vote_count,
    })),
    alignment: {
      last_best_to_number: lastBestToNumber,
      window_min: minNumber,
      window_max: maxNumber,
    },
  };

  await upsertMapping(
    fromSeg.segment_id,
    toEditionId,
    toSegmentStart,
    toSegmentEnd,
    confidence,
    evidence,
    'event-v1'
  );

  return { toSegmentStart, toSegmentEnd, confidence };
}

async function searchEventCandidates(
  embedding: number[],
  toEditionId: string,
  minNumber?: number,
  maxNumber?: number,
  topK: number = 20
): Promise<Array<{ segment_number: number; similarity: number }>> {
  const rangeClause =
    minNumber !== undefined && maxNumber !== undefined
      ? `AND see.segment_number BETWEEN ${minNumber} AND ${maxNumber}`
      : '';

  const sql = `
    SELECT 
      see.segment_number,
      1 - (see.embedding <=> $1::vector) AS similarity
    FROM segment_event_embeddings see
    WHERE see.edition_id = $2 AND see.embedding IS NOT NULL ${rangeClause}
    ORDER BY see.embedding <=> $1::vector
    LIMIT $3
  `;

  const embeddingStr = Array.isArray(embedding) 
    ? `[${embedding.join(',')}]`
    : embedding;
  const rows = await query<any>(sql, [
    embeddingStr,
    toEditionId,
    topK,
  ]);

  return rows.map((r) => ({
    segment_number: parseFloat(r.segment_number),
    similarity: parseFloat(r.similarity) || 0,
  }));
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
