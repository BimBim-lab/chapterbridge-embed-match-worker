import { validateConfig, config } from './config.js';
import { runEmbed } from './embed.js';
import { runEmbedEvents } from './eventEmbed.js';
import { runMatch } from './match.js';
import { runMatchAlign } from './align.js';
import { runMatchEvents } from './eventMatch.js';
import { runMatchEventsGreedy } from './eventMatchGreedy.js';
import { runDerive } from './derive.js';
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

Commands:
  embed              Generate summary/entities embeddings for segments
  embed-events       Generate per-event embeddings for segments
  match              Match segments between editions (independent)
  match-align        Match segments with monotonic alignment (summary/entities)
  match-events       Match segments using event voting algorithm
  match-events-greedy  Match segments using greedy monotonic event-to-event
  derive             Derive cross-media mappings via pivot edition

Usage:
  npm run embed -- --editionId=<uuid> [--limit=5000]
  npm run embed-events -- --editionId=<uuid> [--limit=5000]
  npm run match -- --fromEditionId=<uuid> --toEditionId=<uuid> [--limit=2000]
  npm run match-align -- --fromEditionId=<uuid> --toEditionId=<uuid> [--window=80] [--backtrack=3] [--limit=999999]
  npm run match-events -- --fromEditionId=<uuid> --toEditionId=<uuid> [--window=80] [--backtrack=3] [--limit=999999]
  npm run match-events-greedy -- --fromEditionId=<uuid> --toEditionId=<uuid> [--limit=999999]
  npm run derive -- --fromEditionId=<uuid> --toEditionId=<uuid> --pivotEditionId=<uuid> [--limit=999999]
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
      case 'embed': {
        validateConfig(['supabaseDbUrl', 'openaiApiKey']);
        const editionId = params.editionId;
        if (!editionId) {
          console.error('Error: --editionId is required');
          process.exit(1);
        }
        const limit = parseInt(params.limit || '5000', 10);
        await runEmbed(editionId, limit);
        break;
      }

      case 'embed-events': {
        validateConfig(['supabaseDbUrl', 'openaiApiKey']);
        const editionId = params.editionId;
        if (!editionId) {
          console.error('Error: --editionId is required');
          process.exit(1);
        }
        const limit = parseInt(params.limit || '5000', 10);
        await runEmbedEvents(editionId, limit);
        break;
      }

      case 'match': {
        validateConfig(['supabaseDbUrl']);
        const fromEditionId = params.fromEditionId;
        const toEditionId = params.toEditionId;
        if (!fromEditionId || !toEditionId) {
          console.error('Error: --fromEditionId and --toEditionId are required');
          process.exit(1);
        }
        const limit = parseInt(params.limit || '2000', 10);
        await runMatch(fromEditionId, toEditionId, limit);
        break;
      }

      case 'match-align': {
        validateConfig(['supabaseDbUrl']);
        const fromEditionId = params.fromEditionId;
        const toEditionId = params.toEditionId;
        if (!fromEditionId || !toEditionId) {
          console.error('Error: --fromEditionId and --toEditionId are required');
          process.exit(1);
        }
        const windowSize = parseInt(params.window || String(config.window), 10);
        const backtrack = parseInt(params.backtrack || String(config.backtrack), 10);
        const limit = parseInt(params.limit || '999999', 10);
        await runMatchAlign(fromEditionId, toEditionId, windowSize, backtrack, limit);
        break;
      }

      case 'match-events': {
        validateConfig(['supabaseDbUrl']);
        const fromEditionId = params.fromEditionId;
        const toEditionId = params.toEditionId;
        if (!fromEditionId || !toEditionId) {
          console.error('Error: --fromEditionId and --toEditionId are required');
          process.exit(1);
        }
        const windowSize = parseInt(params.window || String(config.window), 10);
        const backtrack = parseInt(params.backtrack || String(config.backtrack), 10);
        const limit = parseInt(params.limit || '999999', 10);
        await runMatchEvents(fromEditionId, toEditionId, windowSize, backtrack, limit);
        break;
      }

      case 'match-events-greedy': {
        validateConfig(['supabaseDbUrl']);
        const fromEditionId = params.fromEditionId;
        const toEditionId = params.toEditionId;
        if (!fromEditionId || !toEditionId) {
          console.error('Error: --fromEditionId and --toEditionId are required');
          process.exit(1);
        }
        const limit = parseInt(params.limit || '999999', 10);
        await runMatchEventsGreedy(fromEditionId, toEditionId, limit);
        break;
      }

      case 'derive': {
        validateConfig(['supabaseDbUrl']);
        const fromEditionId = params.fromEditionId;
        const toEditionId = params.toEditionId;
        const pivotEditionId = params.pivotEditionId;
        if (!fromEditionId || !toEditionId || !pivotEditionId) {
          console.error(
            'Error: --fromEditionId, --toEditionId, and --pivotEditionId are required'
          );
          process.exit(1);
        }
        const limit = parseInt(params.limit || '999999', 10);
        await runDerive(fromEditionId, toEditionId, pivotEditionId, limit);
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
