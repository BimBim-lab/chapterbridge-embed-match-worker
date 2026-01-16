import { getPool } from './db';
import * as fs from 'fs';
import * as path from 'path';

async function runMigration() {
  const pool = getPool();
  
  try {
    console.log('Starting migration: Add segment_number to segment_mappings...\n');
    
    // Step 1: Add column
    console.log('Step 1: Adding segment_number column...');
    await pool.query(`
      ALTER TABLE segment_mappings 
      ADD COLUMN IF NOT EXISTS segment_number INTEGER
    `);
    console.log('✓ Column added\n');
    
    // Step 2: Populate from segments table
    console.log('Step 2: Populating segment_number from segments table...');
    const updateResult = await pool.query(`
      UPDATE segment_mappings sm
      SET segment_number = s.number
      FROM segments s
      WHERE sm.from_segment_id = s.id
        AND sm.segment_number IS NULL
    `);
    console.log(`✓ Updated ${updateResult.rowCount} rows\n`);
    
    // Step 3: Make NOT NULL
    console.log('Step 3: Making segment_number NOT NULL...');
    await pool.query(`
      ALTER TABLE segment_mappings 
      ALTER COLUMN segment_number SET NOT NULL
    `);
    console.log('✓ Constraint applied\n');
    
    // Step 4: Create index
    console.log('Step 4: Creating index...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_segment_mappings_segment_number 
      ON segment_mappings(segment_number)
    `);
    console.log('✓ Index created\n');
    
    // Verification
    console.log('Verification:');
    const verifyResult = await pool.query(`
      SELECT 
        COUNT(*) as total_mappings,
        COUNT(segment_number) as with_segment_number,
        COUNT(*) FILTER (WHERE segment_number IS NULL) as missing_segment_number
      FROM segment_mappings
    `);
    
    const stats = verifyResult.rows[0];
    console.log(`  Total mappings: ${stats.total_mappings}`);
    console.log(`  With segment_number: ${stats.with_segment_number}`);
    console.log(`  Missing segment_number: ${stats.missing_segment_number}`);
    
    console.log('\n✅ Migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration();
