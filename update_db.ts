import { Pool } from 'pg';

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'solytiq',
  user:     process.env.PGUSER     || 'solytiq',
  password: process.env.PGPASSWORD || 'solytiq_secret',
});

async function run() {
  try {
    await pool.query('ALTER TABLE lists ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;');
    console.log('Column is_public added successfully');
  } catch (err) {
    console.error('Error adding column:', err);
  } finally {
    await pool.end();
  }
}

run();
