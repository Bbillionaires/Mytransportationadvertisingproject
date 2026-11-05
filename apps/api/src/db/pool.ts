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

type ScopedClient = pg.PoolClient & { rmnScope?: string; rmnRoleSet?: boolean };

/**
 * A pg Pool that (1) switches every new connection to the restricted runtime role, so row-level security and
 * trigger protections apply even when the login role is privileged, and (2) applies the current request's tenant
 * scope whenever a connection is checked out (only when it differs from what the connection already has).
 * pg's Pool.query() checks out through connect(), so plain db.query() calls are covered too.
 */
class ScopedPool extends pg.Pool {
  constructor(config: pg.PoolConfig, private readonly runtimeRole: string) {
    super(config);
    // Idle connections can drop (database restart, network); log instead of crashing the process.
    this.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'idle database connection error', error: e.message })));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override connect(cb?: any): any {
    const scope = currentDbScope();
    const p = (async () => {
      const client = (await super.connect()) as ScopedClient;
      // Fail closed: a connection is never handed out until it runs as the restricted role. If SET ROLE fails (e.g.
      // migrations have not created the role), the connection is destroyed and the caller gets an error.
      if (this.runtimeRole && !client.rmnRoleSet) {
        try { await client.query(`SET ROLE ${pg.escapeIdentifier(this.runtimeRole)}`); client.rmnRoleSet = true; }
        catch (e) { client.release(e as Error); throw e; }
      }
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
