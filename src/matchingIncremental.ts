import { query } from './db.js';
import { config } from './config.js';
import { callLLMWithJsonValidation } from './llm.js';
import { formatSegmentLine, SegmentWithEvents } from './formatEvents.js';
import { IncrementalResponseSchema, IncrementalResponse } from './schemas.js';
import { buildIncrementalEvidence } from './evidence.js';
import {
  clamp,
  formatConfidence,
  formatRange,
  rangeWidth,
  determineStatus,
} from './utils.js';

// ============================================================================
// PROMPTS
// ============================================================================

const SYSTEM_PROMPT = `You are a strict story alignment engine. Your task is to align a single episode/chapter to novel chapters using ONLY the provided event lines.

CRITICAL RULES:
1. Output JSON only. No explanations, no markdown, no extra text.
2. Never invent facts not present in the event lines.
3. to_start and to_end MUST be within the provided window.
4. Keep ranges tight: typically 1-6 chapters. Rarely exceed 10.
5. Confidence 0.0-1.0: high (>0.8) for clear matches, medium (0.5-0.8) for partial, low (<0.5) for uncertain.
6. Set needs_wider_window=true if confidence is low and more context might help.
7. anchor_chapters: the 1-3 most strongly matched novel chapters.
8. matched_phrases: 1-3 key phrases/events that match between source and target.

MONOTONIC CONSTRAINT:
- Do not go backwards more than 3 chapters from the checkpoint's last_to_end.

JSON SCHEMA:
{
  "mode": "incremental",
  "checkpoint": {"last_from_number": number, "last_to_end": number},
  "window": {"start": number, "end": number},
  "result": {
    "from_number": number,
    "to_start": number,
    "to_end": number,
    "confidence": number,
    "needs_wider_window": boolean,
    "anchor_chapters": [number],
    "matched_phrases": [string]
  }
}`;

function buildUserPrompt(
  fromLine: string,
  novelLines: string[],
  windowStart: number,
  windowEnd: number,
  checkpoint: { last_from_number: number; last_to_end: number },
  fromNumber: number,
  mediaType: 'anime' | 'manhwa'
): string {
  const prefix = mediaType === 'anime' ? 'episode' : 'chapter';
  return `Align ${prefix} ${fromNumber} to the novel chapters in the window.

CHECKPOINT:
- Last matched ${prefix}: ${checkpoint.last_from_number}
- Last matched novel end: ${checkpoint.last_to_end}

NOVEL_WINDOW (${windowStart}-${windowEnd}):
${novelLines.join('\n')}

NEW_${prefix.toUpperCase()}:
${fromLine}

Return JSON with the mapping. Do not go backwards more than 3 chapters from ${checkpoint.last_to_end}.`;
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

interface CheckpointInfo {
  last_from_number: number;
  last_to_end: number;
  from_segment_id: string;
}

async function fetchCheckpoint(
  fromEditionId: string,
  toNovelEditionId: string
): Promise<CheckpointInfo | null> {
  const sql = `
    SELECT
      s.number::float as from_number,
      sm.to_segment_end,
      sm.from_segment_id
    FROM segment_mappings sm
    JOIN segments s ON s.id = sm.from_segment_id
    WHERE s.edition_id = $1 AND sm.to_edition_id = $2
    ORDER BY s.number DESC
    LIMIT 1
  `;

  const rows = await query<{
    from_number: number;
    to_segment_end: number;
    from_segment_id: string;
  }>(sql, [fromEditionId, toNovelEditionId]);

  if (rows.length === 0) {
    return null;
  }

  return {
    last_from_number: Math.floor(rows[0].from_number),
    last_to_end: rows[0].to_segment_end,
    from_segment_id: rows[0].from_segment_id,
  };
}

async function fetchSegmentWithEvents(
  editionId: string,
  segmentNumber: number
): Promise<SegmentWithEvents | null> {
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
    WHERE s.edition_id = $1 AND s.number = $2
    LIMIT 1
  `;

  const rows = await query<SegmentRow>(sql, [editionId, segmentNumber]);

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    number: parseFloat(row.number),
    segment_type: row.segment_type,
    events: row.events,
    summary_short: row.summary_short,
    summary: row.summary,
  };
}

async function fetchNovelWindow(
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

async function fetchNovelMinMax(editionId: string): Promise<{ min: number; max: number }> {
  const sql = `
    SELECT MIN(s.number)::float as min_num, MAX(s.number)::float as max_num
    FROM segments s
    WHERE s.edition_id = $1
  `;

  const rows = await query<{ min_num: number; max_num: number }>(sql, [editionId]);

  if (rows.length === 0 || rows[0].min_num === null) {
    throw new Error(`No segments found for edition: ${editionId}`);
  }

  return {
    min: Math.floor(rows[0].min_num),
    max: Math.floor(rows[0].max_num),
  };
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
// MAIN FUNCTION
// ============================================================================

export interface MatchIncrementalOptions {
  fromEditionId: string;
  toNovelEditionId: string;
  fromNumber: number;
}

export async function runMatchIncremental(options: MatchIncrementalOptions): Promise<void> {
  const { fromEditionId, toNovelEditionId, fromNumber } = options;

  console.log('\n========================================');
  console.log('INCREMENTAL: Match new segment');
  console.log('========================================');
  console.log(`From Edition: ${fromEditionId}`);
  console.log(`To Novel Edition: ${toNovelEditionId}`);
  console.log(`From Number: ${fromNumber}`);
  console.log(`Model: ${config.openaiModel}`);
  console.log(`Algorithm: ${config.algoVersion}-inc`);
  console.log('');

  // 1. Fetch media types
  const fromMediaType = await fetchEditionMediaType(fromEditionId);
  console.log(`From media type: ${fromMediaType}`);

  // 2. Fetch the segment to match
  const fromSegment = await fetchSegmentWithEvents(fromEditionId, fromNumber);
  if (!fromSegment) {
    console.error(`Segment not found: ${fromMediaType} ${fromNumber}`);
    return;
  }

  console.log(`Loaded segment: ${fromMediaType} ${fromNumber}`);

  // 3. Determine checkpoint
  let checkpoint = await fetchCheckpoint(fromEditionId, toNovelEditionId);
  if (!checkpoint) {
    console.log('No existing mappings found. Starting from beginning.');
    checkpoint = {
      last_from_number: 0,
      last_to_end: 0,
      from_segment_id: '',
    };
  } else {
    console.log(`Checkpoint: last_from=${checkpoint.last_from_number}, last_to_end=${checkpoint.last_to_end}`);
  }

  // 4. Fetch novel min/max
  const novelBounds = await fetchNovelMinMax(toNovelEditionId);
  console.log(`Novel bounds: ${novelBounds.min}-${novelBounds.max}`);

  // 5. Build initial window
  let windowStart = Math.max(novelBounds.min, checkpoint.last_to_end - config.windowBefore);
  let windowEnd = Math.min(novelBounds.max, checkpoint.last_to_end + config.windowAfter);

  // Ensure minimum window size
  const currentWindowSize = windowEnd - windowStart + 1;
  if (currentWindowSize < config.windowSize) {
    const diff = config.windowSize - currentWindowSize;
    windowEnd = Math.min(novelBounds.max, windowEnd + Math.ceil(diff / 2));
    windowStart = Math.max(novelBounds.min, windowStart - Math.floor(diff / 2));
  }

  console.log(`Initial window: ${windowStart}-${windowEnd} (size: ${windowEnd - windowStart + 1})`);

  // 6. Format segment line
  const fromLine = formatSegmentLine(fromSegment, fromMediaType);
  console.log(`From line: ${fromLine.slice(0, 100)}...`);

  // 7. Run matching (with possible retry for wider window)
  let retryInfo: { retried: boolean; original_window?: { start: number; end: number }; reason?: string } = {
    retried: false,
  };
  let response: IncrementalResponse;
  let usedWindow = { start: windowStart, end: windowEnd };

  for (let attempt = 0; attempt < 2; attempt++) {
    // Fetch novel window
    const novelSegments = await fetchNovelWindow(toNovelEditionId, usedWindow.start, usedWindow.end);
    console.log(`Fetched ${novelSegments.length} novel segments for window ${usedWindow.start}-${usedWindow.end}`);

    if (novelSegments.length === 0) {
      console.error('No novel segments in window');
      return;
    }

    // Format novel lines
    const novelLines = novelSegments.map((seg) => formatSegmentLine(seg, 'novel'));

    // Build prompt
    const userPrompt = buildUserPrompt(
      fromLine,
      novelLines,
      usedWindow.start,
      usedWindow.end,
      { last_from_number: checkpoint.last_from_number, last_to_end: checkpoint.last_to_end },
      fromNumber,
      fromMediaType === 'anime' ? 'anime' : 'manhwa'
    );

    // Call LLM
    console.log(`\nCalling LLM (attempt ${attempt + 1})...`);
    try {
      response = await callLLMWithJsonValidation(
        {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
        },
        IncrementalResponseSchema,
        1
      );
    } catch (error) {
      console.error('LLM call failed:', error);
      throw error;
    }

    console.log(`Result: ${formatRange(response.result.to_start, response.result.to_end)} ` +
      `conf=${formatConfidence(response.result.confidence)} needs_wider=${response.result.needs_wider_window}`);

    // Check if we need to expand window
    if (response.result.needs_wider_window && attempt === 0) {
      const currentSize = usedWindow.end - usedWindow.start + 1;
      if (currentSize < config.maxWindowSize) {
        console.log('\nExpanding window for retry...');
        retryInfo = {
          retried: true,
          original_window: { ...usedWindow },
          reason: 'low_confidence',
        };

        // Expand window
        const expansion = Math.min(50, config.maxWindowSize - currentSize);
        usedWindow.start = Math.max(novelBounds.min, usedWindow.start - Math.floor(expansion / 2));
        usedWindow.end = Math.min(novelBounds.max, usedWindow.end + Math.ceil(expansion / 2));
        console.log(`Expanded window: ${usedWindow.start}-${usedWindow.end}`);
        continue;
      }
    }

    // If we get here, we're done
    break;
  }

  // 8. Apply monotonic guard
  let status: 'proposed' | 'approved';
  let adjustedConfidence = response!.result.confidence;

  const backwardJump = checkpoint.last_to_end - response!.result.to_start;
  if (backwardJump > 3 && adjustedConfidence < 0.80) {
    console.warn(`Monotonic violation: backward jump of ${backwardJump} with conf=${formatConfidence(adjustedConfidence)}`);
    status = 'proposed';
    adjustedConfidence = clamp(adjustedConfidence * 0.8, 0, 1);
  } else {
    const width = rangeWidth(response!.result.to_start, response!.result.to_end);
    status = determineStatus(adjustedConfidence, width, config.minConfidence);
  }

  // 9. Build evidence
  const evidence = buildIncrementalEvidence(
    response!.result,
    { last_from_number: checkpoint.last_from_number, last_to_end: checkpoint.last_to_end },
    usedWindow,
    retryInfo.retried ? retryInfo : undefined
  );

  // 10. Upsert mapping
  console.log('\nUpserting mapping...');
  try {
    await upsertMapping(
      fromSegment.id,
      fromEditionId,
      fromNumber,
      toNovelEditionId,
      response!.result.to_start,
      response!.result.to_end,
      clamp(adjustedConfidence, 0, 1),
      evidence,
      status,
      `${config.algoVersion}-inc`
    );

    console.log(
      `  ${fromMediaType === 'anime' ? 'ep' : 'ch'}:${fromNumber} -> ch:${formatRange(response!.result.to_start, response!.result.to_end)} ` +
      `conf=${formatConfidence(adjustedConfidence)} status=${status}`
    );
  } catch (error) {
    console.error('Error upserting mapping:', error);
    throw error;
  }

  console.log('\n========================================');
  console.log('INCREMENTAL COMPLETE');
  console.log('========================================');
  console.log(`Algorithm: ${config.algoVersion}-inc`);
  if (retryInfo.retried) {
    console.log(`Window expanded: ${retryInfo.original_window?.start}-${retryInfo.original_window?.end} -> ${usedWindow.start}-${usedWindow.end}`);
  }
}
