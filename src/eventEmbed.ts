import { query } from './db.js';
import { createEmbeddingsBatch } from './openai.js';
import { config } from './config.js';

interface SegmentWithEvents {
  segment_id: string;
  edition_id: string;
  segment_number: number;
  events: any[] | null;
}

interface EventToEmbed {
  segment_id: string;
  edition_id: string;
  segment_number: number;
  event_idx: number;
  event_text: string;
}

const MAX_EVENTS_PER_SEGMENT = 8;

export async function runEmbedEvents(editionId: string, limit: number): Promise<void> {
  console.log(`Starting event embedding for edition: ${editionId}, limit: ${limit}`);

  const segments = await fetchSegmentsNeedingEventEmbeddings(editionId, limit);
  console.log(`Found ${segments.length} segments to process for event embeddings`);

  if (segments.length === 0) {
    console.log('No segments need event embeddings');
    return;
  }

  let processed = 0;
  let eventsEmbedded = 0;
  let errors = 0;

  for (const segment of segments) {
    try {
      const events = parseEvents(segment.events);
      const eventsToEmbed = events.slice(0, MAX_EVENTS_PER_SEGMENT).filter((t) => t.trim());

      if (eventsToEmbed.length === 0) {
        processed++;
        continue;
      }

      const eventData: EventToEmbed[] = eventsToEmbed.map((text, idx) => ({
        segment_id: segment.segment_id,
        edition_id: segment.edition_id,
        segment_number: segment.segment_number,
        event_idx: idx,
        event_text: text.trim(),
      }));

      const embeddings = await createEmbeddingsBatch(eventData.map((e) => e.event_text));

      for (let i = 0; i < eventData.length; i++) {
        try {
          await upsertEventEmbedding(eventData[i], embeddings[i]);
          eventsEmbedded++;
        } catch (error) {
          errors++;
          console.error(
            `Error upserting event ${eventData[i].event_idx} for segment ${segment.segment_id}:`,
            error
          );
        }
      }

      processed++;
      if (processed % 10 === 0 || processed === segments.length) {
        console.log(
          `Progress: ${processed}/${segments.length} segments, ${eventsEmbedded} events embedded (${errors} errors)`
        );
      }
    } catch (error) {
      errors++;
      console.error(`Error processing segment ${segment.segment_id}:`, error);
    }
  }

  console.log(
    `Event embedding complete. Segments: ${processed}, Events: ${eventsEmbedded}, Errors: ${errors}`
  );
}

async function fetchSegmentsNeedingEventEmbeddings(
  editionId: string,
  limit: number
): Promise<SegmentWithEvents[]> {
  const sql = `
    SELECT DISTINCT
      s.id AS segment_id,
      s.edition_id,
      s.number AS segment_number,
      ss.events
    FROM segments s
    JOIN segment_summaries ss ON ss.segment_id = s.id
    LEFT JOIN segment_event_embeddings see ON see.segment_id = s.id
    WHERE s.edition_id = $1
      AND see.segment_id IS NULL
      AND ss.events IS NOT NULL
      AND jsonb_array_length(ss.events) > 0
    ORDER BY s.number ASC
    LIMIT $2
  `;

  return query<SegmentWithEvents>(sql, [editionId, limit]);
}

function parseEvents(events: any[] | null): string[] {
  if (!events || !Array.isArray(events)) return [];

  const texts: string[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    let text = '';
    if (typeof event === 'string') {
      text = event;
    } else if (event && typeof event === 'object') {
      text = event.text || event.description || '';
    }

    const trimmed = text.trim();
    const normalized = trimmed.toLowerCase();

    if (trimmed && !seen.has(normalized)) {
      seen.add(normalized);
      texts.push(trimmed);
    }
  }

  return texts;
}

async function upsertEventEmbedding(event: EventToEmbed, embedding: number[]): Promise<void> {
  const sql = `
    INSERT INTO segment_event_embeddings (
      segment_id, edition_id, segment_number, event_idx, event_text,
      embedding, embed_model, embed_dim
    )
    VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
    ON CONFLICT (segment_id, event_idx) DO UPDATE SET
      event_text = EXCLUDED.event_text,
      embedding = EXCLUDED.embedding,
      embed_model = EXCLUDED.embed_model,
      embed_dim = EXCLUDED.embed_dim,
      updated_at = NOW()
  `;

  await query(sql, [
    event.segment_id,
    event.edition_id,
    event.segment_number,
    event.event_idx,
    event.event_text,
    `[${embedding.join(',')}]`,
    config.embedModel,
    config.embedDim,
  ]);
}
