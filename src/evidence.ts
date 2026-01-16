import { config } from './config.js';
import { MappingItem, IncrementalResult } from './schemas.js';

/**
 * Evidence building utilities for segment mappings
 */

export interface MatchingAllEvidence {
  mode: 'matching_all';
  model: string;
  from_number: number;
  novel_range: { start: number; end: number };
  anchor_chapters: number[];
  matched_phrases: string[];
  global_confidence: number;
  prompt_version: string;
}

export interface IncrementalEvidence {
  mode: 'incremental';
  model: string;
  from_number: number;
  checkpoint: { last_from_number: number; last_to_end: number };
  window: { start: number; end: number };
  anchor_chapters: number[];
  matched_phrases: string[];
  retry_info?: {
    retried: boolean;
    original_window?: { start: number; end: number };
    reason?: string;
  };
  prompt_version: string;
}

export interface DeriveEvidence {
  mode: 'derive';
  pivot: 'novel';
  anime_to_novel: [number, number];
  chosen_manhwa_to_novel: [number, number];
  overlap_len: number;
  overlap_ratio: number;
  conf_anime: number;
  conf_manhwa: number;
  derived_conf: number;
}

/**
 * Build evidence for matching_all mode
 */
export function buildMatchingAllEvidence(
  mapping: MappingItem,
  novelRange: { start: number; end: number },
  globalConfidence: number
): MatchingAllEvidence {
  return {
    mode: 'matching_all',
    model: config.openaiModel,
    from_number: mapping.from_number,
    novel_range: novelRange,
    anchor_chapters: mapping.anchor_chapters,
    matched_phrases: mapping.matched_phrases,
    global_confidence: globalConfidence,
    prompt_version: 'v1',
  };
}

/**
 * Build evidence for incremental mode
 */
export function buildIncrementalEvidence(
  result: IncrementalResult,
  checkpoint: { last_from_number: number; last_to_end: number },
  window: { start: number; end: number },
  retryInfo?: {
    retried: boolean;
    original_window?: { start: number; end: number };
    reason?: string;
  }
): IncrementalEvidence {
  return {
    mode: 'incremental',
    model: config.openaiModel,
    from_number: result.from_number,
    checkpoint,
    window,
    anchor_chapters: result.anchor_chapters,
    matched_phrases: result.matched_phrases,
    retry_info: retryInfo,
    prompt_version: 'v1',
  };
}

/**
 * Build evidence for derive mode
 */
export function buildDeriveEvidence(
  animeToNovel: [number, number],
  chosenManhwaToNovel: [number, number],
  overlapLen: number,
  overlapRatio: number,
  confAnime: number,
  confManhwa: number,
  derivedConf: number
): DeriveEvidence {
  return {
    mode: 'derive',
    pivot: 'novel',
    anime_to_novel: animeToNovel,
    chosen_manhwa_to_novel: chosenManhwaToNovel,
    overlap_len: overlapLen,
    overlap_ratio: overlapRatio,
    conf_anime: confAnime,
    conf_manhwa: confManhwa,
    derived_conf: derivedConf,
  };
}
