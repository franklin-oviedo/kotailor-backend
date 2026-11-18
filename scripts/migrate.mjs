import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Configure the backend .env first.');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(42180301)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const migrations = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (applied.rowCount) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.info(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(42180301)');
  client.release();
  await pool.end();
}
