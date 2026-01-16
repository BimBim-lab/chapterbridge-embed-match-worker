import { query } from './db.js';
import { config } from './config.js';
import { callLLMWithJsonValidation } from './llm.js';
import { formatSegmentLines, formatSegmentLine, SegmentWithEvents } from './formatEvents.js';
import { MatchingAllResponseSchema, MatchingAllResponse, MappingItem } from './schemas.js';
import { buildMatchingAllEvidence } from './evidence.js';
import { z } from 'zod';
import {
  clamp,
  formatConfidence,
  formatRange,
  rangeWidth,
  determineStatus,
  adjustConfidenceForRange,
} from './utils.js';

// ============================================================================
// PROMPTS
// ============================================================================

const SYSTEM_PROMPT = `You are a strict story alignment engine. Your task is to align episodes or chapters to novel chapters using ONLY the provided event lines.

CRITICAL RULES:
1. Output JSON only. No explanations, no markdown, no extra text.
2. Never invent facts not present in the event lines.
3. Keep monotonic mapping: episode i must map to a chapter range whose start is >= previous start - 3.
4. Keep ranges tight: typically 1-6 chapters per episode. Rarely exceed 10.
5. Confidence 0.0-1.0: high (>0.8) for clear matches, medium (0.5-0.8) for partial, low (<0.5) for uncertain.
6. anchor_chapters: the 1-3 most strongly matched novel chapters.
7. matched_phrases: 1-3 key phrases/events that match between source and target.

JSON SCHEMA:
{
  "mode": "matching_all",
  "novel_range": {"start": number, "end": number},
  "from_range": {"start": number, "end": number},
  "mappings": [
    {
      "from_number": number,
      "to_start": number,
      "to_end": number,
      "confidence": number,
      "anchor_chapters": [number],
      "matched_phrases": [string]
    }
  ],
  "notes": {
    "global_confidence": number,
    "uncertain_from_numbers": [number]
  }
}`;

function buildUserPrompt(
  novelLines: string[],
  fromLines: string[],
  novelStart: number,
  novelEnd: number,
  fromStart: number,
  fromEnd: number,
  mediaType: 'anime' | 'manhwa'
): string {
  const prefix = mediaType === 'anime' ? 'episode' : 'chapter';
  return `Align ${fromLines.length} ${prefix}s to ${novelLines.length} novel chapters.

NOVEL_CHAPTERS (${novelStart}-${novelEnd}):
${novelLines.join('\n')}

FROM_SEGMENTS (${fromStart}-${fromEnd}):
${fromLines.join('\n')}

Return JSON with mappings for each ${prefix}. Keep ranges monotonic and tight.`;
}

// ============================================================================
// DATABASE QUERIES
// ============================================================================

interface SegmentRow {
  id: string;
  number: string;
  segment_type: string;
  events: string[] | null;
  summary_short: string | null;
  summary: string | null;
}

async function fetchSegmentsWithEvents(
  editionId: string,
  startNum: number,
  endNum: number
): Promise<SegmentWithEvents[]> {
  const sql = `
    SELECT
      s.id,
      s.number::text,
      s.segment_type,
      ss.events,
      ss.summary_short,
      ss.summary
    FROM segments s
    LEFT JOIN segment_summaries ss ON ss.segment_id = s.id
    WHERE s.edition_id = $1
      AND s.number >= $2
      AND s.number <= $3
    ORDER BY s.number ASC
  `;

  const rows = await query<SegmentRow>(sql, [editionId, startNum, endNum]);

  return rows.map((row) => ({
    id: row.id,
    number: parseFloat(row.number),
    segment_type: row.segment_type,
    events: row.events,
    summary_short: row.summary_short,
    summary: row.summary,
  }));
}

async function fetchEditionMediaType(editionId: string): Promise<'novel' | 'anime' | 'manhwa'> {
  const sql = `SELECT media_type FROM editions WHERE id = $1`;
  const rows = await query<{ media_type: string }>(sql, [editionId]);

  if (rows.length === 0) {
    throw new Error(`Edition not found: ${editionId}`);
  }

  const mediaType = rows[0].media_type;
  if (mediaType === 'novel' || mediaType === 'anime' || mediaType === 'manhwa') {
    return mediaType;
  }

  throw new Error(`Invalid media_type: ${mediaType}`);
}

async function upsertMapping(
  fromSegmentId: string,
  fromEditionId: string,
  segmentNumber: number,
  toEditionId: string,
  toSegmentStart: number,
  toSegmentEnd: number,
  confidence: number,
  evidence: any,
  status: string,
  algorithmVersion: string
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
        algorithm_version = $8,
        updated_at = NOW()
      WHERE from_segment_id = $9 AND to_edition_id = $10`,
      [
        fromEditionId,
        segmentNumber,
        toSegmentStart,
        toSegmentEnd,
        confidence,
        JSON.stringify(evidence),
        status,
        algorithmVersion,
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        algorithmVersion,
      ]
    );
  }
}

// ============================================================================
// FALLBACK MATCHING
// ============================================================================

const FALLBACK_SYSTEM_PROMPT = `You are a story alignment engine for fallback matching. Your task is to align a SINGLE episode/chapter to novel chapters using ONLY the provided event lines.

CRITICAL RULES:
1. Output JSON only. No explanations, no markdown, no extra text.
2. Never invent facts not present in the event lines.
3. This is fallback matching - be conservative with confidence scores.
4. Keep ranges tight: typically 1-6 chapters.
5. If uncertain, output confidence < 0.6

JSON SCHEMA:
{
  "from_number": number,
  "to_start": number,
  "to_end": number,
  "confidence": number,
  "anchor_chapters": [number],
  "matched_phrases": [string]
}`;

const FallbackResponseSchema = z.object({
  from_number: z.number(),
  to_start: z.number(),
  to_end: z.number(),
  confidence: z.number().min(0).max(1),
  anchor_chapters: z.array(z.number()),
  matched_phrases: z.array(z.string()),
});

async function fallbackSingleSegment(
  segment: SegmentWithEvents,
  allNovelSegments: SegmentWithEvents[],
  fromEditionId: string,
  toEditionId: string,
  mediaType: 'novel' | 'anime' | 'manhwa',
  novelStart: number,
  novelEnd: number
): Promise<{
  fromNumber: number;
  toStart: number;
  toEnd: number;
  confidence: number;
  status: string;
} | null> {
  const fromNum = Math.floor(segment.number);
  const prefix = mediaType === 'anime' ? 'ep' : 'ch';

  // Build smart window around expected range
  const windowCenter = Math.max(novelStart, Math.min(novelEnd, fromNum * 4)); // Estimate
  const windowStart = Math.max(novelStart, windowCenter - config.fallbackWindowSize / 2);
  const windowEnd = Math.min(novelEnd, windowCenter + config.fallbackWindowSize / 2);

  const windowSegments = allNovelSegments.filter(
    (seg) => seg.number >= windowStart && seg.number <= windowEnd
  );

  if (windowSegments.length === 0) {
    console.warn(`  ${prefix}:${fromNum} - No novel segments in fallback window`);
    return null;
  }

  // Format lines
  const fromLine = formatSegmentLine(segment, mediaType);
  const novelLines = windowSegments.map((seg) => formatSegmentLine(seg, 'novel'));

  const userPrompt = `Align ${prefix} ${fromNum} to novel chapters. This is fallback matching, be conservative.

NOVEL_WINDOW (${windowStart}-${windowEnd}):
${novelLines.join('\n')}

SEGMENT_TO_MATCH:
${fromLine}

Return JSON with the mapping. If very uncertain, set confidence < 0.5`;

  let result;
  try {
    result = await callLLMWithJsonValidation(
      {
        systemPrompt: FALLBACK_SYSTEM_PROMPT,
        userPrompt,
      },
      FallbackResponseSchema,
      0 // No retry for fallback
    );
  } catch (error) {
    console.warn(`  ${prefix}:${fromNum} - LLM fallback failed`);
    return null;
  }

  // Apply confidence penalty for fallback
  const penalizedConfidence = clamp(
    result.confidence * config.fallbackConfidencePenalty,
    0,
    1
  );

  // Build evidence
  const evidence = {
    mode: 'matching_all_fallback',
    model: config.openaiModel,
    from_number: fromNum,
    window: { start: windowStart, end: windowEnd },
    anchor_chapters: result.anchor_chapters,
    matched_phrases: result.matched_phrases,
    original_confidence: result.confidence,
    penalized_confidence: penalizedConfidence,
    prompt_version: 'v1-fallback',
  };

  const width = rangeWidth(result.to_start, result.to_end);
  const status = determineStatus(penalizedConfidence, width, config.minConfidence);

  // Upsert
  await upsertMapping(
    segment.id,
    fromEditionId,
    fromNum,
    toEditionId,
    result.to_start,
    result.to_end,
    penalizedConfidence,
    evidence,
    status,
    `${config.algoVersion}-all-fallback`
  );

  return {
    fromNumber: fromNum,
    toStart: result.to_start,
    toEnd: result.to_end,
    confidence: penalizedConfidence,
    status,
  };
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

export interface MatchAllOptions {
  fromEditionId: string;
  toNovelEditionId: string;
  fromStart: number;
  fromEnd: number;
  novelStart: number;
  novelEnd: number;
}

export async function runMatchAll(options: MatchAllOptions): Promise<void> {
  const { fromEditionId, toNovelEditionId, fromStart, fromEnd, novelStart, novelEnd } = options;

  console.log('\n========================================');
  console.log('MATCHING_ALL: Full alignment');
  console.log('========================================');
  console.log(`From Edition: ${fromEditionId}`);
  console.log(`To Novel Edition: ${toNovelEditionId}`);
  console.log(`From Range: ${fromStart}-${fromEnd}`);
  console.log(`Novel Range: ${novelStart}-${novelEnd}`);
  console.log(`Model: ${config.openaiModel}`);
  console.log(`Algorithm: ${config.algoVersion}-all`);
  console.log('');

  // 1. Fetch media types
  const fromMediaType = await fetchEditionMediaType(fromEditionId);
  const toMediaType = await fetchEditionMediaType(toNovelEditionId);

  if (toMediaType !== 'novel') {
    console.warn(`Warning: Target edition is ${toMediaType}, not novel. Proceeding anyway.`);
  }

  console.log(`From media type: ${fromMediaType}`);
  console.log(`To media type: ${toMediaType}`);

  // 2. Fetch segments with events
  console.log('\nFetching segments...');
  const fromSegments = await fetchSegmentsWithEvents(fromEditionId, fromStart, fromEnd);
  const novelSegments = await fetchSegmentsWithEvents(toNovelEditionId, novelStart, novelEnd);

  console.log(`Loaded ${fromSegments.length} from segments (${fromMediaType})`);
  console.log(`Loaded ${novelSegments.length} novel segments`);

  if (fromSegments.length === 0) {
    console.error('No from segments found. Check edition ID and range.');
    return;
  }

  if (novelSegments.length === 0) {
    console.error('No novel segments found. Check edition ID and range.');
    return;
  }

  // 3. Format event lines
  console.log('\nFormatting event lines...');
  const fromLines = formatSegmentLines(fromSegments, fromMediaType);
  const novelLines = formatSegmentLines(novelSegments, 'novel');

  console.log(`From lines: ${fromLines.length}`);
  console.log(`Novel lines: ${novelLines.length}`);

  // Log sample lines
  console.log('\nSample from lines:');
  fromLines.slice(0, 3).forEach((line) => console.log(`  ${line.slice(0, 100)}...`));
  console.log('\nSample novel lines:');
  novelLines.slice(0, 3).forEach((line) => console.log(`  ${line.slice(0, 100)}...`));

  // 4. Build prompt and call LLM
  console.log('\nCalling LLM for alignment...');
  const userPrompt = buildUserPrompt(
    novelLines,
    fromLines,
    novelStart,
    novelEnd,
    fromStart,
    fromEnd,
    fromMediaType === 'anime' ? 'anime' : 'manhwa'
  );

  let response: MatchingAllResponse;
  try {
    response = await callLLMWithJsonValidation(
      {
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
      },
      MatchingAllResponseSchema,
      1 // 1 retry
    );
  } catch (error) {
    console.error('LLM call failed:', error);
    throw error;
  }

  console.log(`\nReceived ${response.mappings.length} mappings from LLM`);
  console.log(`Global confidence: ${formatConfidence(response.notes.global_confidence)}`);
  if (response.notes.uncertain_from_numbers.length > 0) {
    console.log(`Uncertain: ${response.notes.uncertain_from_numbers.join(', ')}`);
  }

  // 5. Build segment ID lookup
  const fromSegmentById = new Map<number, SegmentWithEvents>();
  for (const seg of fromSegments) {
    fromSegmentById.set(Math.floor(seg.number), seg);
  }

  // 6. Upsert mappings
  console.log('\nUpserting mappings...');
  let successCount = 0;
  let errorCount = 0;
  const failedMappings: Array<{ mapping: MappingItem; segment: SegmentWithEvents; error: any }> = [];

  for (const mapping of response.mappings) {
    const fromNum = Math.floor(mapping.from_number);
    const segment = fromSegmentById.get(fromNum);

    if (!segment) {
      console.warn(`  Segment not found for from_number=${fromNum}, skipping`);
      errorCount++;
      continue;
    }

    // Calculate adjusted confidence and status
    const width = rangeWidth(mapping.to_start, mapping.to_end);
    const adjustedConfidence = clamp(
      adjustConfidenceForRange(mapping.confidence, width),
      0,
      1
    );
    const status = determineStatus(adjustedConfidence, width, config.minConfidence);

    // Build evidence
    const evidence = buildMatchingAllEvidence(
      mapping,
      { start: novelStart, end: novelEnd },
      response.notes.global_confidence
    );

    try {
      await upsertMapping(
        segment.id,
        fromEditionId,
        fromNum,
        toNovelEditionId,
        mapping.to_start,
        mapping.to_end,
        adjustedConfidence,
        evidence,
        status,
        `${config.algoVersion}-all`
      );

      console.log(
        `  ${fromMediaType === 'anime' ? 'ep' : 'ch'}:${fromNum} -> ch:${formatRange(mapping.to_start, mapping.to_end)} ` +
        `conf=${formatConfidence(adjustedConfidence)} status=${status}`
      );
      successCount++;
    } catch (error) {
      console.error(`  Error upserting mapping for ${fromNum}:`, error);
      errorCount++;
      failedMappings.push({ mapping, segment, error });
    }
  }

  // 7. Fallback for failed mappings (if enabled)
  if (config.enableFallback && failedMappings.length > 0) {
    console.log(`\n========================================`);
    console.log(`FALLBACK: Retrying ${failedMappings.length} failed segments`);
    console.log(`========================================`);

    for (const { mapping, segment } of failedMappings) {
      try {
        const result = await fallbackSingleSegment(
          segment,
          novelSegments,
          fromEditionId,
          toNovelEditionId,
          fromMediaType,
          novelStart,
          novelEnd
        );

        if (result) {
          console.log(
            `  ${fromMediaType === 'anime' ? 'ep' : 'ch'}:${result.fromNumber} -> ch:${formatRange(result.toStart, result.toEnd)} ` +
            `conf=${formatConfidence(result.confidence)} status=${result.status} [FALLBACK]`
          );
          successCount++;
          errorCount--;
        }
      } catch (error) {
        console.error(`  Fallback failed for ${fromMediaType === 'anime' ? 'ep' : 'ch'}:${Math.floor(segment.number)}:`, error);
      }
    }
  }

  console.log('\n========================================');
  console.log('MATCHING_ALL COMPLETE');
  console.log('========================================');
  console.log(`Mappings created: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Algorithm: ${config.algoVersion}-all`);
}
