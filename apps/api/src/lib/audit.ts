import type { Queryable } from '../db/pool.js';

export interface AuditActor {
  userId?: string | null;
  deviceId?: string | null;
  impersonatorUserId?: string | null;
  requestId?: string | null;
}

export async function audit(
  q: Queryable,
  actor: AuditActor,
  action: string,
  target: { type?: string; id?: string | null; orgId?: string | null } = {},
  details: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (actor_user_id, actor_device_id, impersonator_user_id, org_id, action, target_type, target_id, request_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [actor.userId ?? null, actor.deviceId ?? null, actor.impersonatorUserId ?? null, target.orgId ?? null, action, target.type ?? null, target.id ?? null, actor.requestId ?? null, JSON.stringify(details)],
  );
}
