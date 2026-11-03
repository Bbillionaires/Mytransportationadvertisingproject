import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Forward-only migrations, each applied in its own transaction, checksummed to detect edits to applied files. */
export async function migrate(url: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(7342000)');
    const applied = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const ran: string[] = [];
    for (const f of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(f);
      if (prior) {
        if (prior !== checksum) throw new Error(`migration ${f} was modified after being applied; add a new migration instead`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      log(`applied ${f}`);
      ran.push(f);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7342000)').catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  migrate(url).then((r) => console.log(r.length ? `done (${r.length} applied)` : 'up to date')).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
