import { validateConfig, config } from './config.js';
import { runMatchAll } from './matchingAll.js';
import { runMatchIncremental } from './matchingIncremental.js';
import { runDeriveAnimeManhwa } from './deriveAnimeManhwa.js';
import { closePool } from './db.js';

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (key && value !== undefined) {
        result[key] = value;
      }
    }
  }
  return result;
}

function printUsage(): void {
  console.log(`
ChapterBridge Embed/Match Worker

=== LLM-BASED MATCHING (EVENTS-ONLY, RECOMMENDED) ===

  match-all          Full alignment using GPT-4.1 LLM with events
  match-new          Incremental matching for new episodes/chapters
  derive-llm         Derive anime->manhwa mappings via novel pivot

Usage:
  npm run match-all -- --fromEditionId=<uuid> --toNovelEditionId=<uuid> --fromStart=<int> --fromEnd=<int> --novelStart=<int> --novelEnd=<int>
  npm run match-new -- --fromEditionId=<uuid> --toNovelEditionId=<uuid> --fromNumber=<int>
  npm run derive -- --animeEditionId=<uuid> --manhwaEditionId=<uuid> --novelEditionId=<uuid>

=== LEGACY EMBEDDING-BASED COMMANDS ===

  embed              Generate summary/entities embeddings for segments
  embed-events       Generate per-event embeddings for segments
  match              Match segments between editions (independent)
  match-align        Match segments with monotonic alignment (summary/entities)
  match-events       Match segments using event voting algorithm
  match-events-greedy  Match segments using greedy monotonic event-to-event
  derive-legacy      Derive cross-media mappings via pivot edition (legacy)

Usage:
  npm run embed -- --editionId=<uuid> [--limit=5000]
  npm run embed-events -- --editionId=<uuid> [--limit=5000]
  npm run match -- --fromEditionId=<uuid> --toEditionId=<uuid> [--limit=2000]
  npm run match-align -- --fromEditionId=<uuid> --toEditionId=<uuid> [--window=80] [--backtrack=3] [--limit=999999]
  npm run match-events -- --fromEditionId=<uuid> --toEditionId=<uuid> [--window=80] [--backtrack=3] [--limit=999999]
  npm run match-events-greedy -- --fromEditionId=<uuid> --toEditionId=<uuid> [--limit=999999]
  npm run derive-legacy -- --fromEditionId=<uuid> --toEditionId=<uuid> --pivotEditionId=<uuid> [--limit=999999]
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const params = parseArgs(args.slice(1));

  if (!command || command === 'help' || command === '--help') {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'derive': {
        // New LLM-based derive (anime->manhwa via novel)
        validateConfig(['supabaseDbUrl']);
        const animeEditionId = params.animeEditionId;
        const manhwaEditionId = params.manhwaEditionId;
        const novelEditionId = params.novelEditionId;
        if (!animeEditionId || !manhwaEditionId || !novelEditionId) {
          console.error(
            'Error: --animeEditionId, --manhwaEditionId, and --novelEditionId are required'
          );
          process.exit(1);
        }
        await runDeriveAnimeManhwa({
          animeEditionId,
          manhwaEditionId,
          novelEditionId,
        });
        break;
      }

      case 'match-all': {
        // LLM-based full alignment
        validateConfig(['supabaseDbUrl', 'openaiApiKey']);
        const fromEditionId = params.fromEditionId;
        const toNovelEditionId = params.toNovelEditionId;
        const fromStart = params.fromStart;
        const fromEnd = params.fromEnd;
        const novelStart = params.novelStart;
        const novelEnd = params.novelEnd;
        if (!fromEditionId || !toNovelEditionId || !fromStart || !fromEnd || !novelStart || !novelEnd) {
          console.error(
            'Error: --fromEditionId, --toNovelEditionId, --fromStart, --fromEnd, --novelStart, --novelEnd are required'
          );
          process.exit(1);
        }
        await runMatchAll({
          fromEditionId,
          toNovelEditionId,
          fromStart: parseInt(fromStart, 10),
          fromEnd: parseInt(fromEnd, 10),
          novelStart: parseInt(novelStart, 10),
          novelEnd: parseInt(novelEnd, 10),
        });
        break;
      }

      case 'match-new': {
        // LLM-based incremental matching
        validateConfig(['supabaseDbUrl', 'openaiApiKey']);
        const fromEditionId = params.fromEditionId;
        const toNovelEditionId = params.toNovelEditionId;
        const fromNumber = params.fromNumber;
        if (!fromEditionId || !toNovelEditionId || !fromNumber) {
          console.error(
            'Error: --fromEditionId, --toNovelEditionId, and --fromNumber are required'
          );
          process.exit(1);
        }
        await runMatchIncremental({
          fromEditionId,
          toNovelEditionId,
          fromNumber: parseInt(fromNumber, 10),
        });
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
