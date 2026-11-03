/** IndexedDB: a key-value store (device identity, settings) and a durable event queue for offline operation. */
const DB_NAME = 'rmn-player';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('events', { keyPath: 'eventId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : (undefined as T));
    t.onerror = () => reject(t.error);
  }));
}

export const kvGet = <T>(k: string) => tx<T | undefined>('kv', 'readonly', (s) => s.get(k) as IDBRequest<T | undefined>);
export const kvSet = (k: string, v: unknown) => tx('kv', 'readwrite', (s) => { s.put(v, k); });
export const kvDel = (k: string) => tx('kv', 'readwrite', (s) => { s.delete(k); });

export const queuePut = (ev: { eventId: string }) => tx('events', 'readwrite', (s) => { s.put(ev); });
export const queueTake = (n: number) => tx<any[]>('events', 'readonly', (s) => s.getAll(undefined, n));
export const queueCount = () => tx<number>('events', 'readonly', (s) => s.count());
export const queueDelete = (ids: string[]) => tx('events', 'readwrite', (s) => { for (const id of ids) s.delete(id); });
