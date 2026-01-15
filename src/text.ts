export interface EventItem {
  idx?: number;
  text?: string;
}

export interface EntityItem {
  name?: string;
  term?: string;
}

export function buildSummaryText(summaryShort: string | null, summary: string | null): string {
  const parts: string[] = [];
  if (summaryShort) parts.push(summaryShort);
  if (summary) parts.push(summary);
  return parts.join('\n').trim() || '';
}

export function buildEventsText(events: (EventItem | string)[] | null): string {
  if (!events || !Array.isArray(events)) return '';

  const lines: string[] = [];
  events.forEach((event, idx) => {
    let text = '';
    if (typeof event === 'string') {
      text = event;
    } else if (event && typeof event === 'object') {
      text = event.text || '';
    }
    if (text.trim()) {
      lines.push(`${idx + 1}) ${text.trim()}`);
    }
  });

  return lines.join('\n');
}

export function buildEntitiesText(
  characters: (EntityItem | string)[] | null,
  locations: (EntityItem | string)[] | null,
  keywords: (EntityItem | string)[] | null,
  maxItems = 50
): string {
  const extractNames = (items: (EntityItem | string)[] | null): string[] => {
    if (!items || !Array.isArray(items)) return [];
    return items
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return item.name || item.term || '';
        }
        return '';
      })
      .filter((name) => name.trim() !== '');
  };

  const chars = [...new Set(extractNames(characters))];
  const locs = [...new Set(extractNames(locations))];
  const keys = [...new Set(extractNames(keywords))];

  const allItems = [...chars, ...locs, ...keys];
  const total = allItems.length;

  let charLimit = chars.length;
  let locLimit = locs.length;
  let keyLimit = keys.length;

  if (total > maxItems) {
    const ratio = maxItems / total;
    charLimit = Math.floor(chars.length * ratio);
    locLimit = Math.floor(locs.length * ratio);
    keyLimit = Math.floor(keys.length * ratio);
  }

  const parts: string[] = [];
  if (charLimit > 0 && chars.length > 0) {
    parts.push(`CHARS: ${chars.slice(0, charLimit).join(', ')}`);
  }
  if (locLimit > 0 && locs.length > 0) {
    parts.push(`LOCS: ${locs.slice(0, locLimit).join(', ')}`);
  }
  if (keyLimit > 0 && keys.length > 0) {
    parts.push(`KEY: ${keys.slice(0, keyLimit).join(', ')}`);
  }

  return parts.join('\n');
}
