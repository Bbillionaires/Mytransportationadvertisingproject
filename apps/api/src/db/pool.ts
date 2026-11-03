import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Run fn inside a transaction. Deferred constraints (ledger balance) are checked at COMMIT. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, isolation: 'READ COMMITTED' | 'SERIALIZABLE' = 'READ COMMITTED'): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
