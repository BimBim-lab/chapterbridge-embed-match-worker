import { query } from './db.js';
import { config } from './config.js';

// Greedy monotonic matching constraints
const EVENT_MATCH_CONFIDENCE_THRESHOLD = 0.3;  // Lowered: Allow more matches, filter with window
const MIN_EVENT_MATCHES_PER_EPISODE = 1;       // Very low: Accept single strong match
const MAX_RANGE_WIDTH = 10;                     // Reduced: Maximum chapter range per episode
const CLUSTER_GAP = 2;                          // Tightened: Max gap between chapters
const MAX_PROGRESSIVE_JUMP = 8;                 // Balanced: Allow some progression variance
const SEARCH_WINDOW = 30;                       // NEW: Max chapters ahead to search for matches

interface EventMatch {
  from_episode: number;
  from_event_idx: number;
  to_chapter: number;
  similarity: number;
}

interface EpisodeChapterRange {
  episode: number;
  chapter_start: number;
  chapter_end: number;
  confidence: number;
  event_matches: number;
  evidence: any;
}

export async function runMatchEventsGreedy(
  fromEditionId: string,
  toEditionId: string,
  limit: number
): Promise<void> {
  console.log(`\nStarting greedy event-to-event matching:`);
  console.log(`  From: ${fromEditionId}`);
  console.log(`  To: ${toEditionId}`);
  console.log(`  Event confidence threshold: ${EVENT_MATCH_CONFIDENCE_THRESHOLD}`);
  console.log(`  Min event matches per episode: ${MIN_EVENT_MATCHES_PER_EPISODE}`);
  console.log(`  Max range width: ${MAX_RANGE_WIDTH}`);
  console.log(`  Search window: ${SEARCH_WINDOW} chapters`);
  console.log(`  Max progressive jump: ${MAX_PROGRESSIVE_JUMP} chapters/episode\n`);

  // Step 1: Get all episodes from source edition
  const episodesResult = await query<any>(`
    SELECT DISTINCT s.number as episode
    FROM segments s
    WHERE s.edition_id = $1
    ORDER BY s.number ASC
  `, [fromEditionId]);
  
  const episodes = episodesResult.map(r => parseFloat(r.episode));
  console.log(`Processing ${episodes.length} episodes in order\n`);

  // Step 2: Greedy monotonic matching with window constraint
  let lastMatchedChapter = 0;
  const results: EpisodeChapterRange[] = [];
  let matched = 0;
  let skipped = 0;

  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    
    // Get event matches for this episode within search window
    const windowStart = lastMatchedChapter;
    const windowEnd = lastMatchedChapter + SEARCH_WINDOW;
    
    const eventMatches = await getEpisodeEventMatches(
      fromEditionId, 
      toEditionId, 
      episode,
      windowStart,
      windowEnd
    );
    
    if (eventMatches.length === 0) {
      console.log(`  Episode ${episode}: No matches in window [${windowStart}, ${windowEnd}], skipping`);
      skipped++;
      continue;
    }

    // Check minimum event matches requirement
    if (eventMatches.length < MIN_EVENT_MATCHES_PER_EPISODE) {
      console.log(`  Episode ${episode}: Only ${eventMatches.length} event matches (min ${MIN_EVENT_MATCHES_PER_EPISODE}), skipping`);
      skipped++;
      continue;
    }

    // Get chapter range from matches
    const result = determineChapterRange(episode, eventMatches, lastMatchedChapter);
    
    if (!result) {
      console.log(`  Episode ${episode}: Failed to determine range, skipping`);
      skipped++;
      continue;
    }

    // Progressive jump detection
    if (results.length > 0) {
      const prevResult = results[results.length - 1];
      const jump = result.chapter_start - prevResult.chapter_end;
      const episodeDiff = episode - prevResult.episode;
      const expectedMaxJump = episodeDiff * MAX_PROGRESSIVE_JUMP;
      
      if (jump > expectedMaxJump) {
        console.log(`  Episode ${episode}: Jump ${jump} exceeds expected ${expectedMaxJump} (${episodeDiff} episodes × ${MAX_PROGRESSIVE_JUMP}), skipping`);
        skipped++;
        continue;
      }
    }

    results.push(result);
    matched++;
    
    // Update lastMatchedChapter to the end of current range
    lastMatchedChapter = result.chapter_end;
    
    console.log(`  Episode ${episode}: chapters ${result.chapter_start}-${result.chapter_end} (width: ${result.chapter_end - result.chapter_start + 1}, conf: ${result.confidence.toFixed(3)}, matches: ${result.event_matches})`);
  }

  // Step 3: Save to database
  console.log(`\nSaving ${matched} mappings to database...`);
  for (const result of results) {
    await saveEpisodeMapping(fromEditionId, toEditionId, result);
  }

  console.log(`\nGreedy matching complete:`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Skipped: ${skipped}`);
}

async function getEpisodeEventMatches(
  fromEditionId: string,
  toEditionId: string,
  episode: number,
  windowStart: number,
  windowEnd: number
): Promise<EventMatch[]> {
  // Get event matches for specific episode within window
  const sql = `
    SELECT 
      $3::INTEGER as from_episode,
      see_from.event_idx as from_event_idx,
      see_to.segment_number as to_chapter,
      1 - (see_from.embedding <=> see_to.embedding) AS similarity
    FROM segment_event_embeddings see_from
    JOIN segments s ON s.id = see_from.segment_id
    CROSS JOIN LATERAL (
      SELECT segment_number, embedding
      FROM segment_event_embeddings
      WHERE edition_id = $2 
        AND embedding IS NOT NULL
        AND segment_number >= $4
        AND segment_number <= $5
      ORDER BY embedding <=> see_from.embedding
      LIMIT 5
    ) see_to
    WHERE see_from.edition_id = $1
      AND see_from.embedding IS NOT NULL
      AND s.number = $3
      AND (1 - (see_from.embedding <=> see_to.embedding)) >= $6
    ORDER BY from_event_idx ASC, similarity DESC
  `;

  const rows = await query<any>(sql, [
    fromEditionId,
    toEditionId,
    episode,
    windowStart,
    windowEnd,
    EVENT_MATCH_CONFIDENCE_THRESHOLD,
  ]);

  return rows.map(r => ({
    from_episode: parseFloat(r.from_episode),
    from_event_idx: r.from_event_idx,
    to_chapter: parseFloat(r.to_chapter),
    similarity: parseFloat(r.similarity),
  }));
}

async function getAllEventMatches(
  fromEditionId: string,
  toEditionId: string
): Promise<EventMatch[]> {
  // Get all events from source edition
  const sql = `
    SELECT 
      s.number as from_episode,
      see_from.event_idx as from_event_idx,
      see_to.segment_number as to_chapter,
      1 - (see_from.embedding <=> see_to.embedding) AS similarity
    FROM segment_event_embeddings see_from
    JOIN segments s ON s.id = see_from.segment_id
    CROSS JOIN LATERAL (
      SELECT segment_number, embedding
      FROM segment_event_embeddings
      WHERE edition_id = $2 AND embedding IS NOT NULL
      ORDER BY embedding <=> see_from.embedding
      LIMIT 5
    ) see_to
    WHERE see_from.edition_id = $1
      AND see_from.embedding IS NOT NULL
      AND (1 - (see_from.embedding <=> see_to.embedding)) >= $3
    ORDER BY s.number ASC, from_event_idx ASC, similarity DESC
  `;

  const rows = await query<any>(sql, [
    fromEditionId,
    toEditionId,
    EVENT_MATCH_CONFIDENCE_THRESHOLD,
  ]);

  return rows.map(r => ({
    from_episode: parseFloat(r.from_episode),
    from_event_idx: r.from_event_idx,
    to_chapter: parseFloat(r.to_chapter),
    similarity: parseFloat(r.similarity),
  }));
}

function determineChapterRange(
  episode: number,
  matches: EventMatch[],
  minChapter: number
): EpisodeChapterRange | null {
  // Get all matched chapters
  const chapters = matches.map(m => m.to_chapter);
  const uniqueChapters = Array.from(new Set(chapters)).sort((a, b) => a - b);

  if (uniqueChapters.length === 0) {
    return null;
  }

  // Find the smallest contiguous cluster of chapters
  let bestCluster = findBestCluster(uniqueChapters, matches);

  // Apply range cap
  if (bestCluster.end - bestCluster.start + 1 > MAX_RANGE_WIDTH) {
    const midpoint = Math.floor((bestCluster.start + bestCluster.end) / 2);
    const half = Math.floor(MAX_RANGE_WIDTH / 2);
    bestCluster.start = Math.max(minChapter, midpoint - half);
    bestCluster.end = bestCluster.start + MAX_RANGE_WIDTH - 1;
  }

  // Calculate confidence (average of matched events in range)
  const matchesInRange = matches.filter(
    m => m.to_chapter >= bestCluster.start && m.to_chapter <= bestCluster.end
  );
  
  const avgConfidence = matchesInRange.reduce((sum, m) => sum + m.similarity, 0) / matchesInRange.length;

  return {
    episode,
    chapter_start: bestCluster.start,
    chapter_end: bestCluster.end,
    confidence: avgConfidence,
    event_matches: matchesInRange.length,
    evidence: {
      algorithm: 'greedy-event-monotonic',
      event_match_threshold: EVENT_MATCH_CONFIDENCE_THRESHOLD,
      min_chapter_constraint: minChapter,
      total_events_matched: matches.length,
      events_in_range: matchesInRange.length,
      top_chapters: uniqueChapters.slice(0, 10),
      chapter_vote_histogram: getChapterHistogram(matches),
    },
  };
}

function findBestCluster(chapters: number[], matches: EventMatch[]): { start: number; end: number } {
  if (chapters.length === 1) {
    return { start: chapters[0], end: chapters[0] };
  }

  // Find clusters (groups of chapters within CLUSTER_GAP of each other)
  const clusters: Array<{ start: number; end: number; weight: number }> = [];
  let currentStart = chapters[0];
  let currentEnd = chapters[0];
  let currentWeight = 0;

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const weight = matches.filter(m => m.to_chapter === chapter).length;

    if (i === 0 || chapter - currentEnd <= CLUSTER_GAP) {
      currentEnd = chapter;
      currentWeight += weight;
    } else {
      clusters.push({ start: currentStart, end: currentEnd, weight: currentWeight });
      currentStart = chapter;
      currentEnd = chapter;
      currentWeight = weight;
    }
  }
  clusters.push({ start: currentStart, end: currentEnd, weight: currentWeight });

  // Return cluster with highest weight
  clusters.sort((a, b) => b.weight - a.weight);
  return { start: clusters[0].start, end: clusters[0].end };
}

function getChapterHistogram(matches: EventMatch[]): Record<number, number> {
  const histogram: Record<number, number> = {};
  for (const match of matches) {
    histogram[match.to_chapter] = (histogram[match.to_chapter] || 0) + 1;
  }
  return histogram;
}

async function saveEpisodeMapping(
  fromEditionId: string,
  toEditionId: string,
  result: EpisodeChapterRange
): Promise<void> {
  // Get segment_id for this episode
  const segmentSql = `
    SELECT id FROM segments
    WHERE edition_id = $1 AND number = $2
  `;
  const segments = await query<any>(segmentSql, [fromEditionId, result.episode]);
  
  if (segments.length === 0) {
    console.warn(`    No segment found for episode ${result.episode}, skipping save`);
    return;
  }

  const segmentId = segments[0].id;

  // Upsert mapping
  const upsertSql = `
    INSERT INTO segment_mappings (
      from_segment_id, to_edition_id, to_segment_start, to_segment_end,
      confidence, evidence, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (from_segment_id, to_edition_id)
    DO UPDATE SET
      to_segment_start = EXCLUDED.to_segment_start,
      to_segment_end = EXCLUDED.to_segment_end,
      confidence = EXCLUDED.confidence,
      evidence = EXCLUDED.evidence,
      updated_at = NOW()
  `;

  await query(upsertSql, [
    segmentId,
    toEditionId,
    result.chapter_start,
    result.chapter_end,
    result.confidence,
    JSON.stringify(result.evidence),
  ]);
}
