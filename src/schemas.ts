import { z } from 'zod';

// ============================================================================
// MATCHING_ALL SCHEMA
// ============================================================================

export const MappingItemSchema = z.object({
  from_number: z.number(),
  to_start: z.number(),
  to_end: z.number(),
  confidence: z.number().min(0).max(1),
  anchor_chapters: z.array(z.number()),
  matched_phrases: z.array(z.string()),
});

export const MatchingAllNotesSchema = z.object({
  global_confidence: z.number().min(0).max(1),
  uncertain_from_numbers: z.array(z.number()),
});

export const MatchingAllResponseSchema = z.object({
  mode: z.literal('matching_all'),
  novel_range: z.object({
    start: z.number(),
    end: z.number(),
  }),
  from_range: z.object({
    start: z.number(),
    end: z.number(),
  }),
  mappings: z.array(MappingItemSchema),
  notes: MatchingAllNotesSchema,
});

export type MappingItem = z.infer<typeof MappingItemSchema>;
export type MatchingAllResponse = z.infer<typeof MatchingAllResponseSchema>;

// ============================================================================
// INCREMENTAL SCHEMA
// ============================================================================

export const IncrementalResultSchema = z.object({
  from_number: z.number(),
  to_start: z.number(),
  to_end: z.number(),
  confidence: z.number().min(0).max(1),
  needs_wider_window: z.boolean(),
  anchor_chapters: z.array(z.number()),
  matched_phrases: z.array(z.string()),
});

export const IncrementalResponseSchema = z.object({
  mode: z.literal('incremental'),
  checkpoint: z.object({
    last_from_number: z.number(),
    last_to_end: z.number(),
  }),
  window: z.object({
    start: z.number(),
    end: z.number(),
  }),
  result: IncrementalResultSchema,
});

export type IncrementalResult = z.infer<typeof IncrementalResultSchema>;
export type IncrementalResponse = z.infer<typeof IncrementalResponseSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

export function validateMatchingAllResponse(data: unknown): MatchingAllResponse {
  return MatchingAllResponseSchema.parse(data);
}

export function validateIncrementalResponse(data: unknown): IncrementalResponse {
  return IncrementalResponseSchema.parse(data);
}
