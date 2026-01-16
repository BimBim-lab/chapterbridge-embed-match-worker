import { getPool } from './db';

async function checkSegments() {
  const pool = getPool();
  
  try {
    // Check ALL episodes from anime edition
    const episodes = await pool.query(`
      SELECT id, number, title
      FROM segments
      WHERE edition_id = 'a36e20e1-6dd9-443c-9331-d917c767df13'
      ORDER BY number
      LIMIT 5
    `);
    
    console.log('\nFirst 5 episodes from anime:');
    episodes.rows.forEach(row => {
      console.log(`  Episode ${row.number}: ${row.id}`);
      console.log(`    ${row.title}`);
    });
    
    // Check current mappings for episode 1 and 2
    const mappings = await pool.query(`
      SELECT 
        sm.id,
        s.number as episode,
        s.id as episode_id,
        sm.to_segment_start,
        sm.to_segment_end,
        sm.confidence
      FROM segment_mappings sm
      JOIN segments s ON sm.from_segment_id = s.id
      WHERE s.edition_id = 'a36e20e1-6dd9-443c-9331-d917c767df13'
        AND sm.to_edition_id = '057d82a8-73d3-456d-b385-217b4f94c83b'
        AND s.number IN (1, 2, 3)
      ORDER BY s.number
    `);
    
    console.log('\nCurrent mappings for episodes 1-3:');
    mappings.rows.forEach(row => {
      console.log(`  Episode ${row.episode} (${row.episode_id})`);
      console.log(`    → Chapters ${row.to_segment_start}-${row.to_segment_end} (conf: ${row.confidence.toFixed(3)})`);
    });
    
  } finally {
    await pool.end();
  }
}

checkSegments();
