import type { Device } from './device';
import { queueCount, queueDelete, queuePut, queueTake } from './store';

/** Events are written to IndexedDB first, so playback is never lost offline; the server dedupes replays by eventId. */
export async function record(e: Record<string, unknown> & { type: string }) {
  await queuePut({ ...e, eventId: crypto.randomUUID() });
}

let flushing = false;
export async function flush(device: Device): Promise<{ sent: number; pending: number }> {
  if (flushing || !navigator.onLine) return { sent: 0, pending: await queueCount() };
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const batch = await queueTake(200);
      if (!batch.length) break;
      await device.call('POST', '/v1/devices/events', { batchId: crypto.randomUUID(), events: batch });
      await queueDelete(batch.map((e) => e.eventId)); // accepted, duplicate or rejected-as-malformed: all are settled
      sent += batch.length;
    }
  } catch { /* offline or server error: keep the queue, retry later */ } finally { flushing = false; }
  return { sent, pending: await queueCount() };
}
