/**
 * Utility functions
 */

/**
 * Clamp a number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safe floor for numeric values
 */
export function safeFloor(value: number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return isNaN(num) ? 0 : Math.floor(num);
}

/**
 * Format a confidence value for display
 */
export function formatConfidence(confidence: number): string {
  return (confidence * 100).toFixed(1) + '%';
}

/**
 * Format a range for display
 */
export function formatRange(start: number, end: number): string {
  if (start === end) {
    return String(start);
  }
  return `${start}-${end}`;
}

/**
 * Calculate range width
 */
export function rangeWidth(start: number, end: number): number {
  return end - start + 1;
}

/**
 * Check if two ranges overlap
 */
export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

/**
 * Calculate overlap length between two ranges
 */
export function overlapLength(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start + 1);
}

/**
 * Calculate overlap ratio (relative to smaller range)
 */
export function overlapRatio(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  const overlap = overlapLength(aStart, aEnd, bStart, bEnd);
  if (overlap === 0) return 0;

  const lenA = aEnd - aStart + 1;
  const lenB = bEnd - bStart + 1;
  return overlap / Math.min(lenA, lenB);
}

/**
 * Generate a UUID (simple version for evidence)
 */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get current timestamp in ISO format
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Determine status based on confidence and range width
 */
export function determineStatus(
  confidence: number,
  rangeWidth: number,
  minConfidence: number,
  maxReasonableRangeWidth = 20
): 'proposed' | 'approved' {
  // Always return 'proposed' - let human review handle approval
  return 'proposed';
}

/**
 * Adjust confidence for wide ranges
 */
export function adjustConfidenceForRange(
  confidence: number,
  rangeWidth: number,
  wideRangeThreshold = 20,
  penalty = 0.7
): number {
  if (rangeWidth > wideRangeThreshold) {
    return clamp(confidence * penalty, 0, 1);
  }
  return confidence;
}
