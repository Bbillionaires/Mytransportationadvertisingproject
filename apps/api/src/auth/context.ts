import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { sha256hex } from '../lib/crypto.js';
import type { AuditActor } from '../lib/audit.js';

export interface Membership {
  orgId: string;
  orgKind: 'PLATFORM' | 'FLEET_OPERATOR' | 'ADVERTISER' | 'CREATOR_STUDIO';
  role: string;
  permissions: Set<string>;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  mfaVerified: boolean;
  mfaEnabled: boolean;
  emailVerified: boolean;
  impersonatorUserId: string | null;
  memberships: Membership[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    rawBody?: string;
  }
}

let permFlags: { mfa: Set<string>; verified: Set<string> } | null = null;
async function loadPermissionFlags(db: Db) {
  if (!permFlags) {
    const r = await db.query<{ code: string; requires_mfa: boolean; requires_verified_email: boolean }>('SELECT code, requires_mfa, requires_verified_email FROM permissions');
    permFlags = { mfa: new Set(r.rows.filter((x) => x.requires_mfa).map((x) => x.code)), verified: new Set(r.rows.filter((x) => x.requires_verified_email).map((x) => x.code)) };
  }
  return permFlags;
}

export async function resolveSession(db: Db, req: FastifyRequest): Promise<AuthContext | undefined> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return undefined;
  const token = h.slice(7).trim();
  if (!token) return undefined;
  const s = await db.query(
    `SELECT s.id, s.user_id, s.mfa_verified_at, s.impersonator_user_id, u.mfa_enabled, u.email_verified_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'ACTIVE'`,
    [sha256hex(token)],
  );
  const row = s.rows[0];
  if (!row) return undefined;
  const m = await db.query(
    `SELECT m.org_id, o.kind, m.role_code, coalesce(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS perms
       FROM memberships m JOIN organizations o ON o.id = m.org_id AND o.status = 'ACTIVE'
       LEFT JOIN role_permissions rp ON rp.role_code = m.role_code
      WHERE m.user_id = $1 AND m.status = 'ACTIVE'
      GROUP BY m.org_id, o.kind, m.role_code`,
    [row.user_id],
  );
  return {
    userId: row.user_id,
    sessionId: row.id,
    mfaVerified: row.mfa_verified_at !== null,
    mfaEnabled: row.mfa_enabled,
    emailVerified: row.email_verified_at !== null,
    impersonatorUserId: row.impersonator_user_id,
    memberships: m.rows.map((r) => ({ orgId: r.org_id, orgKind: r.kind, role: r.role_code, permissions: new Set(r.perms as string[]) })),
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function actorOf(req: FastifyRequest): AuditActor {
  return { userId: req.auth?.userId ?? null, impersonatorUserId: req.auth?.impersonatorUserId ?? null, requestId: req.id };
}

/**
 * Server-side RBAC with tenant isolation.
 *  - Platform-scope permission (no orgId): granted only via a PLATFORM-org membership.
 *  - Org-scope permission: granted via membership in that exact org, or via a PLATFORM membership
 *    (platform staff operate across tenants; every such access is audited by the caller).
 *  - Permissions flagged requires_mfa demand an MFA-verified session, and are never available
 *    to impersonation sessions.
 */
export async function authorize(db: Db, req: FastifyRequest, permission: string, orgId?: string): Promise<AuthContext> {
  const auth = requireAuth(req);
  const flags = await loadPermissionFlags(db);
  const grants = auth.memberships.filter(
    (m) => m.permissions.has(permission) && (m.orgKind === 'PLATFORM' || (orgId !== undefined && m.orgId === orgId)),
  );
  if (grants.length === 0) throw forbidden(`missing permission ${permission}${orgId ? ' for this organization' : ''}`);
  if (flags.verified.has(permission) && !auth.emailVerified) throw forbidden('verify your email address to use this feature', 'EMAIL_NOT_VERIFIED');
  if (flags.mfa.has(permission)) {
    if (auth.impersonatorUserId) throw forbidden('privileged actions are not available while impersonating', 'IMPERSONATION_RESTRICTED');
    if (!auth.mfaEnabled || !auth.mfaVerified) throw forbidden('this action requires a multi-factor authenticated session', 'MFA_REQUIRED');
  }
  return auth;
}

