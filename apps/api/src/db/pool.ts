import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * Tenant scope for database row-level security (migration 0016). '' = system (jobs, tablets, riders, keys),
 * 'platform' = staff, 'tenant:<ids>' = a business user's organizations. Set per request by the app (see app.ts).
 */
const scopeStore = new AsyncLocalStorage<string>();
export const runWithDbScope = <T>(scope: string, fn: () => T): T => scopeStore.run(scope, fn);
export const currentDbScope = () => scopeStore.getStore() ?? '';

type ScopedClient = pg.PoolClient & { rmnScope?: string };

/**
 * A pg Pool that (1) switches every new connection to the restricted runtime role, so row-level security and
 * trigger protections apply even when the login role is privileged, and (2) applies the current request's tenant
 * scope whenever a connection is checked out (only when it differs from what the connection already has).
 * pg's Pool.query() checks out through connect(), so plain db.query() calls are covered too.
 */
class ScopedPool extends pg.Pool {
  constructor(config: pg.PoolConfig, private readonly runtimeRole: string) {
    super(config);
    if (runtimeRole) this.on('connect', (c) => { c.query(`SET ROLE ${pg.escapeIdentifier(runtimeRole)}`).catch((e) => this.emit('error', e, c)); });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override connect(cb?: any): any {
    const scope = currentDbScope();
    const p = (async () => {
      const client = (await super.connect()) as ScopedClient;
      if (client.rmnScope !== scope) {
        try { await client.query(`SELECT set_config('rmn.scope', $1, false)`, [scope]); client.rmnScope = scope; }
        catch (e) { client.release(e as Error); throw e; }
      }
      return client;
    })();
    if (typeof cb === 'function') { p.then((c) => cb(undefined, c, (err?: Error) => c.release(err)), (e) => cb(e)); return undefined; }
    return p;
  }
}

export function createPool(url: string, opts: { runtimeRole?: string } = {}): Db {
  return new ScopedPool({ connectionString: url, max: 10 }, opts.runtimeRole ?? process.env.DB_RUNTIME_ROLE ?? 'rmn_app');
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
