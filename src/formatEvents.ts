/**
 * Format segment events into compact lines for LLM matching
 *
 * Format: "ch:<N> | e1; e2; e3; e4" or "ep:<N> | e1; e2; e3; e4"
 */

const MAX_EVENTS = 6;
const MIN_EVENTS = 4;
const MAX_EVENT_LENGTH = 140;

export interface SegmentWithEvents {
  id: string;
  number: number;
  segment_type: string;
  events: string[] | null;
  summary_short: string | null;
  summary: string | null;
}

/**
 * Format a single segment into an event line
 */
export function formatSegmentLine(segment: SegmentWithEvents, mediaType: 'novel' | 'anime' | 'manhwa'): string {
  const prefix = getLinePrefix(mediaType, segment.number);
  const events = extractEvents(segment);
  const cleanedEvents = cleanAndDedupeEvents(events);
  const selectedEvents = selectEvents(cleanedEvents);
  const formattedEvents = selectedEvents.map(truncateEvent);

  if (formattedEvents.length === 0) {
    return `${prefix} | [no events]`;
  }

  return `${prefix} | ${formattedEvents.join('; ')}`;
}

/**
 * Format multiple segments into event lines
 */
export function formatSegmentLines(
  segments: SegmentWithEvents[],
  mediaType: 'novel' | 'anime' | 'manhwa'
): string[] {
  return segments.map((seg) => formatSegmentLine(seg, mediaType));
}

/**
 * Get line prefix based on media type
 */
function getLinePrefix(mediaType: 'novel' | 'anime' | 'manhwa', number: number): string {
  if (mediaType === 'anime') {
    return `ep:${Math.floor(number)}`;
  }
  return `ch:${Math.floor(number)}`;
}

/**
 * Extract events from segment, with fallbacks
 */
function extractEvents(segment: SegmentWithEvents): string[] {
  // Primary: segment_summaries.events
  if (segment.events && Array.isArray(segment.events) && segment.events.length > 0) {
    return segment.events.filter((e): e is string => typeof e === 'string' && e.trim().length > 0);
  }

  // Fallback 1: summary_short
  if (segment.summary_short && segment.summary_short.trim()) {
    return [segment.summary_short.trim()];
  }

  // Fallback 2: first sentence of summary
  if (segment.summary && segment.summary.trim()) {
    const firstSentence = extractFirstSentence(segment.summary);
    if (firstSentence) {
      return [firstSentence];
    }
  }

  return [];
}

/**
 * Extract first sentence from text
 */
function extractFirstSentence(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]/);
  if (match) {
    return match[0].trim();
  }
  // If no sentence ending found, take first 200 chars
  return text.slice(0, 200).trim();
}

/**
 * Clean and deduplicate events
 */
function cleanAndDedupeEvents(events: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const event of events) {
    // Normalize for deduplication
    const normalized = normalizeForDedup(event);
    if (!seen.has(normalized) && normalized.length > 0) {
      seen.add(normalized);
      result.push(cleanEvent(event));
    }
  }

  return result;
}

/**
 * Normalize event for deduplication (case-insensitive, collapse whitespace)
 */
function normalizeForDedup(event: string): string {
  return event
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean a single event (remove newlines, collapse whitespace)
 */
function cleanEvent(event: string): string {
  return event
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Select the most informative events (4-6 events)
 */
function selectEvents(events: string[]): string[] {
  if (events.length <= MIN_EVENTS) {
    return events;
  }

  if (events.length <= MAX_EVENTS) {
    return events;
  }

  // Take first MAX_EVENTS (preserve order, assume events are in chronological order)
  return events.slice(0, MAX_EVENTS);
}

/**
 * Truncate event to max length
 */
function truncateEvent(event: string): string {
  if (event.length <= MAX_EVENT_LENGTH) {
    return event;
  }
  return event.slice(0, MAX_EVENT_LENGTH - 3) + '...';
}

/**
 * Get media type prefix for display
 */
export function getMediaTypePrefix(mediaType: 'novel' | 'anime' | 'manhwa'): string {
  switch (mediaType) {
    case 'anime':
      return 'ep';
    case 'novel':
    case 'manhwa':
    default:
      return 'ch';
  }
}
