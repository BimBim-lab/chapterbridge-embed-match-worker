import { query } from './db.js';
import { createEmbedding } from './openai.js';
import { config } from './config.js';
import { buildSummaryText, buildEventsText, buildEntitiesText } from './text.js';

interface SegmentToEmbed {
  segment_id: string;
  summary_short: string | null;
  summary: string | null;
  events: any[] | null;
  characters: any[] | null;
  locations: any[] | null;
  keywords: any[] | null;
}

export async function runEmbed(editionId: string, limit: number): Promise<void> {
  console.log(`Starting embedding for edition: ${editionId}, limit: ${limit}`);

  const segments = await fetchSegmentsToEmbed(editionId, limit);
  console.log(`Found ${segments.length} segments needing embeddings`);

  if (segments.length === 0) {
    console.log('No segments to embed');
    return;
  }

  let processed = 0;
  let errors = 0;

  for (const segment of segments) {
    try {
      await embedSegment(segment);
      processed++;
      if (processed % 10 === 0 || processed === segments.length) {
        console.log(`Progress: ${processed}/${segments.length} (${errors} errors)`);
      }
    } catch (error) {
      errors++;
      console.error(`Error embedding segment ${segment.segment_id}:`, error);
    }
  }

  console.log(`Embedding complete. Processed: ${processed}, Errors: ${errors}`);
}

async function fetchSegmentsToEmbed(
  editionId: string,
  limit: number
): Promise<SegmentToEmbed[]> {
  const sql = `
    SELECT 
      s.id AS segment_id,
      ss.summary_short,
      ss.summary,
      ss.events,
      se.characters,
      se.locations,
      se.keywords
    FROM segments s
    JOIN segment_summaries ss ON ss.segment_id = s.id
    JOIN segment_entities se ON se.segment_id = s.id
    LEFT JOIN segment_embeddings emb ON emb.segment_id = s.id
    WHERE s.edition_id = $1
      AND emb.segment_id IS NULL
    ORDER BY s.number ASC
    LIMIT $2
  `;

  return query<SegmentToEmbed>(sql, [editionId, limit]);
}

async function embedSegment(segment: SegmentToEmbed): Promise<void> {
  const summaryText = buildSummaryText(segment.summary_short, segment.summary);
  const eventsText = buildEventsText(segment.events);
  const entitiesText = buildEntitiesText(
    segment.characters,
    segment.locations,
    segment.keywords
  );

  const [embSummary, embEvents, embEntities] = await Promise.all([
    summaryText ? createEmbedding(summaryText) : null,
    eventsText ? createEmbedding(eventsText) : null,
    entitiesText ? createEmbedding(entitiesText) : null,
  ]);

  const upsertSql = `
    INSERT INTO segment_embeddings (
      segment_id, embedding_summary, embedding_events, embedding_entities,
      embed_model, embed_dim
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (segment_id) DO UPDATE SET
      embedding_summary = EXCLUDED.embedding_summary,
      embedding_events = EXCLUDED.embedding_events,
      embedding_entities = EXCLUDED.embedding_entities,
      embed_model = EXCLUDED.embed_model,
      embed_dim = EXCLUDED.embed_dim,
      updated_at = NOW()
  `;

  await query(upsertSql, [
    segment.segment_id,
    embSummary ? `[${embSummary.join(',')}]` : null,
    embEvents ? `[${embEvents.join(',')}]` : null,
    embEntities ? `[${embEntities.join(',')}]` : null,
    config.embedModel,
    config.embedDim,
  ]);
}
