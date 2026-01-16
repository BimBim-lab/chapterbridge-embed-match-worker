import { query } from './db.js';

interface MappingRow {
  from_segment_id: string;
  from_segment_number: number;
  to_segment_start: number;
  to_segment_end: number;
  confidence: number;
  evidence: any;
  algo_version: string;
}

async function analyzeMapping(fromEditionId: string, toEditionId: string) {
  console.log(`\n=== ANALYZING MAPPINGS: ${fromEditionId} -> ${toEditionId} ===\n`);

  const sql = `
    SELECT 
      sm.from_segment_id,
      s.number as from_segment_number,
      sm.to_segment_start,
      sm.to_segment_end,
      sm.confidence,
      sm.evidence
    FROM segment_mappings sm
    JOIN segments s ON s.id = sm.from_segment_id
    WHERE s.edition_id = $1 
      AND sm.to_edition_id = $2
    ORDER BY s.number ASC
  `;

  const rows = await query<MappingRow>(sql, [fromEditionId, toEditionId]);

  if (rows.length === 0) {
    console.log('No mappings found!');
    return;
  }

  console.log(`Total mappings: ${rows.length}\n`);

  // 1. Distribusi panjang range
  const rangeLengths = rows.map(r => r.to_segment_end - r.to_segment_start + 1);
  const avgRange = rangeLengths.reduce((a, b) => a + b, 0) / rangeLengths.length;
  const maxRange = Math.max(...rangeLengths);
  const minRange = Math.min(...rangeLengths);
  
  console.log('📊 RANGE LENGTH DISTRIBUTION:');
  console.log(`  Average: ${avgRange.toFixed(2)}`);
  console.log(`  Min: ${minRange}, Max: ${maxRange}`);
  
  const rangeHistogram: Record<string, number> = {};
  rangeLengths.forEach(len => {
    const bucket = len <= 5 ? '1-5' : len <= 10 ? '6-10' : len <= 20 ? '11-20' : len <= 50 ? '21-50' : '>50';
    rangeHistogram[bucket] = (rangeHistogram[bucket] || 0) + 1;
  });
  console.log('  Histogram:', rangeHistogram);

  // 2. Distribusi jump antar segment
  const jumps: number[] = [];
  const backwards: Array<{from: number, jump: number, prevStart: number, currStart: number}> = [];
  
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const jump = curr.to_segment_start - prev.to_segment_start;
    jumps.push(jump);
    
    if (jump < 0) {
      backwards.push({
        from: curr.from_segment_number,
        jump,
        prevStart: prev.to_segment_start,
        currStart: curr.to_segment_start
      });
    }
  }

  console.log('\n📈 JUMP DISTRIBUTION:');
  console.log(`  Average jump: ${(jumps.reduce((a, b) => a + b, 0) / jumps.length).toFixed(2)}`);
  console.log(`  Max forward jump: ${Math.max(...jumps)}`);
  console.log(`  Backwards count: ${backwards.length}`);
  
  if (backwards.length > 0) {
    console.log('\n⚠️  BACKWARD JUMPS:');
    backwards.forEach(b => {
      console.log(`    Segment ${b.from}: jumped ${b.jump} (${b.prevStart} -> ${b.currStart})`);
    });
  }

  // 3. Top 10 widest ranges
  const widest = rows
    .map(r => ({
      from: r.from_segment_number,
      range: r.to_segment_end - r.to_segment_start + 1,
      start: r.to_segment_start,
      end: r.to_segment_end,
      confidence: r.confidence,
      evidence: r.evidence
    }))
    .sort((a, b) => b.range - a.range)
    .slice(0, 10);

  console.log('\n🔴 TOP 10 WIDEST RANGES:');
  widest.forEach((w, i) => {
    console.log(`  ${i + 1}. Segment ${w.from}: range ${w.range} (${w.start}-${w.end}), conf: ${w.confidence.toFixed(3)}`);
    if (w.evidence?.vote_histogram) {
      const topVotes = Object.entries(w.evidence.vote_histogram)
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 3);
      console.log(`     Top votes: ${topVotes.map((v: any) => `ch${v[0]}:${v[1]}`).join(', ')}`);
    }
  });

  // 4. Top 10 biggest jumps
  const bigJumps = jumps
    .map((jump, i) => ({
      fromSegment: rows[i + 1].from_segment_number,
      jump,
      prevStart: rows[i].to_segment_start,
      currStart: rows[i + 1].to_segment_start
    }))
    .sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump))
    .slice(0, 10);

  console.log('\n🔴 TOP 10 BIGGEST JUMPS:');
  bigJumps.forEach((j, i) => {
    console.log(`  ${i + 1}. Segment ${j.fromSegment}: jump ${j.jump} (${j.prevStart} -> ${j.currStart})`);
  });

  // 5. Outlier detection
  console.log('\n🚨 OUTLIERS:');
  const outliers = rows.filter(r => {
    const rangeLen = r.to_segment_end - r.to_segment_start + 1;
    return rangeLen > 20 || r.confidence < 0.5;
  });
  
  console.log(`  Found ${outliers.length} outliers (range > 20 OR confidence < 0.5)`);
  outliers.slice(0, 5).forEach(o => {
    const rangeLen = o.to_segment_end - o.to_segment_start + 1;
    console.log(`    Segment ${o.from_segment_number}: range ${rangeLen}, conf ${o.confidence.toFixed(3)}`);
  });

  // 6. Recommendations
  console.log('\n💡 RECOMMENDATIONS:');
  if (maxRange > 20) {
    console.log('  ⚠️  Max range is too wide! Suggest:');
    console.log('     - Add RANGE_CAP = 15');
    console.log('     - Tighten cluster threshold from 0.02 to 0.01');
  }
  
  if (Math.max(...jumps) > 50) {
    console.log('  ⚠️  Large forward jumps detected! Suggest:');
    console.log('     - Add MAX_FORWARD_JUMP = 30');
    console.log('     - Apply jump penalty: -0.1 per 10 chapters over limit');
  }
  
  if (backwards.length > rows.length * 0.2) {
    console.log('  ⚠️  Too many backward jumps! Suggest:');
    console.log('     - Reduce backtrack from 3 to 2');
    console.log('     - Increase backward penalty');
  }

  console.log('\n');
}

// Run analysis
const fromEditionId = process.argv[2] || 'a36e20e1-6dd9-443c-9331-d917c767df13';
const toEditionId = process.argv[3] || '057d82a8-73d3-456d-b385-217b4f94c83b';

analyzeMapping(fromEditionId, toEditionId)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
