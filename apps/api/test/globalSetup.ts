import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';

export default async function setup() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_DB, () => {});
}
