export interface ScoringWeights {
  summaryWeight: number;
  eventsWeight: number;
  summaryComboWeight: number;
  entitiesWeight: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  summaryWeight: 0.6,
  eventsWeight: 0.4,
  summaryComboWeight: 0.8,
  entitiesWeight: 0.2,
};

export function computeFinalScore(
  simSummary: number,
  simEvents: number,
  simEntities: number,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  const simSummaryCombo =
    weights.summaryWeight * simSummary + weights.eventsWeight * simEvents;
  return weights.summaryComboWeight * simSummaryCombo + weights.entitiesWeight * simEntities;
}

export function applyTimeContextAdjustment(
  score: number,
  fromTimeContext: string,
  toTimeContext: string
): number {
  const fromNorm = normalizeTimeContext(fromTimeContext);
  const toNorm = normalizeTimeContext(toTimeContext);

  if (fromNorm === toNorm && fromNorm !== 'unknown') {
    return score + 0.02;
  }

  const mismatchPairs = [
    ['present', 'flashback'],
    ['present', 'future'],
    ['flashback', 'future'],
  ];

  for (const [a, b] of mismatchPairs) {
    if ((fromNorm === a && toNorm === b) || (fromNorm === b && toNorm === a)) {
      return score - 0.03;
    }
  }

  return score;
}

function normalizeTimeContext(ctx: string | null | undefined): string {
  if (!ctx) return 'unknown';
  const lower = ctx.toLowerCase().trim();
  if (['present', 'flashback', 'future'].includes(lower)) return lower;
  return 'unknown';
}

export function computeEntityOverlap(
  fromEntities: { characters?: any[]; locations?: any[]; keywords?: any[] },
  toEntities: { characters?: any[]; locations?: any[]; keywords?: any[] }
): { characters: string[]; locations: string[]; keywords: string[] } {
  const extractNames = (items: any[] | undefined): Set<string> => {
    if (!items || !Array.isArray(items)) return new Set();
    return new Set(
      items
        .map((item) => {
          if (typeof item === 'string') return item.toLowerCase();
          if (item && typeof item === 'object') {
            const name = item.name || item.term || '';
            return name.toLowerCase();
          }
          return '';
        })
        .filter((n) => n !== '')
    );
  };

  const intersect = (a: Set<string>, b: Set<string>): string[] => {
    return [...a].filter((x) => b.has(x));
  };

  const fromChars = extractNames(fromEntities.characters);
  const toChars = extractNames(toEntities.characters);

  const fromLocs = extractNames(fromEntities.locations);
  const toLocs = extractNames(toEntities.locations);

  const fromKeys = extractNames(fromEntities.keywords);
  const toKeys = extractNames(toEntities.keywords);

  return {
    characters: intersect(fromChars, toChars),
    locations: intersect(fromLocs, toLocs),
    keywords: intersect(fromKeys, toKeys),
  };
}
