import { query } from './db.js';
import { config } from './config.js';

// Enhanced constraints for better matching
const MAX_RANGE_WIDTH = 15;        // Maximum range width (end - start + 1)
const MAX_FORWARD_JUMP = 30;       // Maximum forward jump allowed
const CLUSTER_THRESHOLD = 0.01;    // Tighter clustering (was 0.02)
const JUMP_PENALTY_PER_10 = 0.1;   // Penalty per 10 chapters over MAX_FORWARD_JUMP
const MIN_CONFIDENCE = 0.4;        // Minimum confidence to accept mapping

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
  let baseConfidence = top.avg_similarity;
  
  // Apply tighter clustering threshold
  const threshold = top.avg_similarity - CLUSTER_THRESHOLD;
  let inRange = segmentVotes.filter((v) => v.avg_similarity >= threshold);

  // Form contiguous cluster around the best match
  const bestSegNum = top.segment_number;
  const sorted = inRange.map(v => v.segment_number).sort((a, b) => a - b);
  
  // Find contiguous cluster containing the best match
  let clusterStart = bestSegNum;
  let clusterEnd = bestSegNum;
  
  for (const num of sorted) {
    if (num >= clusterStart - 2 && num <= clusterEnd + 2) {
      clusterStart = Math.min(clusterStart, num);
      clusterEnd = Math.max(clusterEnd, num);
    }
  }
  
  const toSegmentStart = clusterStart;
  const toSegmentEnd = clusterEnd;
  const rangeWidth = toSegmentEnd - toSegmentStart + 1;

  // Apply range cap
  if (rangeWidth > MAX_RANGE_WIDTH) {
    console.warn(`  Segment ${fromSeg.segment_number}: Range too wide (${rangeWidth}), capping to ${MAX_RANGE_WIDTH}`);
    const midpoint = Math.floor((toSegmentStart + toSegmentEnd) / 2);
    const half = Math.floor(MAX_RANGE_WIDTH / 2);
    const cappedStart = midpoint - half;
    const cappedEnd = cappedStart + MAX_RANGE_WIDTH - 1;
    
    // Update to capped range
    inRange = inRange.filter(v => v.segment_number >= cappedStart && v.segment_number <= cappedEnd);
  }

  // Apply forward jump penalty
  if (lastBestToNumber !== null) {
    const forwardJump = toSegmentStart - lastBestToNumber;
    
    if (forwardJump > MAX_FORWARD_JUMP) {
      const excessJump = forwardJump - MAX_FORWARD_JUMP;
      const penalty = (excessJump / 10) * JUMP_PENALTY_PER_10;
      baseConfidence -= penalty;
      console.warn(`  Segment ${fromSeg.segment_number}: Large jump ${forwardJump}, applying penalty -${penalty.toFixed(3)}`);
    }
    
    // Reject if jump is too extreme (>2x MAX_FORWARD_JUMP)
    if (forwardJump > MAX_FORWARD_JUMP * 2) {
      console.warn(`  Segment ${fromSeg.segment_number}: Jump ${forwardJump} exceeds 2x limit, rejecting`);
      return null;
    }
  }

  const confidence = Math.max(0, Math.min(1, baseConfidence));

  // Reject low confidence matches
  if (confidence < MIN_CONFIDENCE) {
    console.warn(`  Segment ${fromSeg.segment_number}: Confidence ${confidence.toFixed(3)} below threshold ${MIN_CONFIDENCE}, rejecting`);
    return null;
  }

  // Recalculate final range after all filters
  const finalNumbers = inRange.map((v) => v.segment_number);
  const finalStart = Math.min(...finalNumbers);
  const finalEnd = Math.max(...finalNumbers);
  const finalWidth = finalEnd - finalStart + 1;

  const evidence = {
    algorithm: 'event-voting-v2',
    from_event_count: fromSeg.event_embeddings.length,
    vote_histogram: Object.fromEntries(
      segmentVotes.slice(0, 10).map(v => [v.segment_number, v.vote_count])
    ),
    top_candidates: segmentVotes.slice(0, 5).map((v) => ({
      segment_number: v.segment_number,
      avg_similarity: v.avg_similarity,
      vote_count: v.vote_count,
    })),
    cluster_info: {
      best_segment: bestSegNum,
      cluster_start: clusterStart,
      cluster_end: clusterEnd,
      cluster_width: rangeWidth,
      final_width: finalWidth,
      threshold_used: CLUSTER_THRESHOLD,
    },
    alignment: {
      last_best_to_number: lastBestToNumber,
      window_min: minNumber,
      window_max: maxNumber,
      forward_jump: lastBestToNumber !== null ? finalStart - lastBestToNumber : null,
    },
    score_details: {
      base_confidence: top.avg_similarity,
      final_confidence: confidence,
      penalties_applied: top.avg_similarity - confidence,
    },
  };

  await upsertMapping(
    fromSeg.segment_id,
    fromSeg.segment_number,
    toEditionId,
    finalStart,
    finalEnd,
    confidence,
    evidence,
    'event-v2'
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
  segmentNumber: number,
  toEditionId: string,
  toSegmentStart: number,
  toSegmentEnd: number,
  confidence: number,
  evidence: any,
  algoVersion: string
): Promise<void> {
  const sql = `
    INSERT INTO segment_mappings (
      from_segment_id, segment_number, to_edition_id, to_segment_start, to_segment_end,
      confidence, evidence, status, algorithm_version
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed', $8)
    ON CONFLICT (from_segment_id, to_edition_id) DO UPDATE SET
      segment_number = EXCLUDED.segment_number,
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
    segmentNumber,
    toEditionId,
    toSegmentStart,
    toSegmentEnd,
    confidence,
    JSON.stringify(evidence),
    algoVersion,
  ]);
}
