/**
 * Android hardware key attestation (R-028). At enrollment the Android shell generates its identity key with a
 * server-issued challenge; Android's secure hardware then returns a certificate chain, rooted in a Google attestation
 * root, whose leaf describes the key (KeyDescription extension, OID 1.3.6.1.4.1.11129.2.1.17). Verifying it proves:
 *   - the enrolled public key was generated inside a TEE or StrongBox and cannot be exported,
 *   - for this enrollment (the challenge is fresh and single-use),
 *   - by our app (attestationApplicationId package name), on a device with verified boot and a locked bootloader.
 * Reference: https://developer.android.com/privacy-and-security/security-key-attestation
 */
import { X509Certificate, createPublicKey } from 'node:crypto';
import { children, derBool, derInt, derOid, expect, parseDer, UNIVERSAL, type DerNode } from '../../lib/der.js';
import { GOOGLE_ATTESTATION_ROOTS_PEM } from './googleAttestationRoots.js';

export const KEY_DESCRIPTION_OID = '1.3.6.1.4.1.11129.2.1.17';
export const SHELL_PACKAGE = 'net.ridesharemedia.shell';

export type SecurityLevel = 'SOFTWARE' | 'TRUSTED_ENVIRONMENT' | 'STRONGBOX';
export type BootState = 'VERIFIED' | 'SELF_SIGNED' | 'UNVERIFIED' | 'FAILED';

export interface AttestationTrust {
  /** SubjectPublicKeyInfo (DER) of each trusted root. */
  rootsSpki: Buffer[];
  /** Serial numbers (lowercase hex, no leading zeros) Google lists as revoked or suspended; null = list unavailable. */
  revokedSerials: () => Promise<Set<string> | null>;
}

export interface AttestationResult {
  securityLevel: SecurityLevel;
  attestationVersion: number;
  bootState: BootState;
  deviceLocked: boolean;
  packageName: string;
  /** Whether the revocation list was available when the chain was checked. */
  revocationChecked: boolean;
}

export class AttestationError extends Error {
  constructor(public reason: string) { super(`key attestation failed: ${reason}`); }
}

const fail = (reason: string): never => { throw new AttestationError(reason); };
const SECURITY: Record<number, SecurityLevel> = { 0: 'SOFTWARE', 1: 'TRUSTED_ENVIRONMENT', 2: 'STRONGBOX' };
const BOOT: Record<number, BootState> = { 0: 'VERIFIED', 1: 'SELF_SIGNED', 2: 'UNVERIFIED', 3: 'FAILED' };
const TAG = { ORIGIN: 702, ROOT_OF_TRUST: 704, APPLICATION_ID: 709 } as const;
const ORIGIN_GENERATED = 0;

export const spkiOf = (c: X509Certificate) => c.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
export const normalizeSerial = (hex: string) => hex.toLowerCase().replace(/^0+(?=.)/, '');

/** Google's pinned roots (googleAttestationRoots.ts) plus the live revocation list, cached. */
export function googleAttestationTrust(fetchStatus: () => Promise<Set<string> | null> = cachedGoogleStatusList()): AttestationTrust {
  return { rootsSpki: GOOGLE_ATTESTATION_ROOTS_PEM.map((p) => spkiOf(new X509Certificate(p))), revokedSerials: fetchStatus };
}

export const GOOGLE_STATUS_URL = 'https://android.googleapis.com/attestation/status';

/** Fetches Google's attestation revocation list at most once an hour; keeps the last good copy if a refresh fails. */
export function cachedGoogleStatusList(url = GOOGLE_STATUS_URL, ttlMs = 60 * 60_000): () => Promise<Set<string> | null> {
  let cached: { at: number; set: Set<string> } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.set;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!r.ok) throw new Error(`status ${r.status}`);
      cached = { at: Date.now(), set: parseStatusList(await r.json()) };
    } catch {
      // Network trouble must not block enrollment; the result records that revocation was not checked.
    }
    return cached?.set ?? null;
  };
}

export function parseStatusList(json: unknown): Set<string> {
  const entries = (json as { entries?: Record<string, { status?: string }> })?.entries;
  if (!entries || typeof entries !== 'object') throw new Error('malformed attestation status list');
  return new Set(Object.entries(entries).filter(([, v]) => v?.status === 'REVOKED' || v?.status === 'SUSPENDED').map(([k]) => normalizeSerial(k)));
}

/** Finds an extension's value (the OCTET STRING contents) in a certificate's DER. */
export function certExtension(certDer: Buffer, oid: string): Buffer | null {
  const tbs = children(expect(parseDer(certDer), 0, UNIVERSAL.SEQUENCE, 'Certificate'))[0];
  if (!tbs) return fail('certificate has no TBSCertificate');
  const extsWrapper = children(tbs).find((n) => n.cls === 2 && n.tag === 3);
  if (!extsWrapper) return null;
  const [exts] = children(extsWrapper);
  for (const ext of children(exts!)) {
    const parts = children(ext);
    if (derOid(parts[0]!) !== oid) continue;
    const value = parts[parts.length - 1]!;
    expect(value, 0, UNIVERSAL.OCTET_STRING, 'extension value');
    return value.value;
  }
  return null;
}

/** Context-tagged entries of an AuthorizationList, keyed by tag number (each [n] EXPLICIT wraps one value). */
function authList(n: DerNode): Map<number, DerNode> {
  expect(n, 0, UNIVERSAL.SEQUENCE, 'AuthorizationList');
  const m = new Map<number, DerNode>();
  for (const e of children(n)) {
    if (e.cls !== 2 || !e.constructed) fail('malformed authorization list');
    const inner = children(e);
    if (inner.length !== 1) fail('malformed authorization list entry');
    m.set(e.tag, inner[0]!);
  }
  return m;
}

export interface KeyDescription {
  attestationVersion: number;
  attestationSecurityLevel: number;
  keymasterSecurityLevel: number;
  challenge: Buffer;
  software: Map<number, DerNode>;
  hardware: Map<number, DerNode>;
}

export function parseKeyDescription(ext: Buffer): KeyDescription {
  const f = children(expect(parseDer(ext), 0, UNIVERSAL.SEQUENCE, 'KeyDescription'));
  if (f.length < 8) fail('KeyDescription is too short');
  return {
    attestationVersion: derInt(f[0]!),
    attestationSecurityLevel: derInt(f[1]!),
    keymasterSecurityLevel: derInt(f[3]!),
    challenge: expect(f[4]!, 0, UNIVERSAL.OCTET_STRING, 'attestationChallenge').value,
    software: authList(f[6]!),
    hardware: authList(f[7]!),
  };
}

/** AttestationApplicationId: SEQUENCE { SET OF AttestationPackageInfo { name OCTET STRING, version INTEGER }, SET OF digest }. */
function packageNames(appId: DerNode): string[] {
  const inner = parseDer(expect(appId, 0, UNIVERSAL.OCTET_STRING, 'attestationApplicationId').value);
  const [infos] = children(expect(inner, 0, UNIVERSAL.SEQUENCE, 'AttestationApplicationId'));
  return children(expect(infos!, 0, UNIVERSAL.SET, 'package infos')).map((p) => {
    const [name] = children(expect(p, 0, UNIVERSAL.SEQUENCE, 'AttestationPackageInfo'));
    return expect(name!, 0, UNIVERSAL.OCTET_STRING, 'package name').value.toString('utf8');
  });
}

export async function verifyAttestation(opts: {
  chainB64: string[];
  publicKeyDer: Buffer;
  challenge: Buffer;
  trust: AttestationTrust;
  packageName?: string;
  now?: Date;
}): Promise<AttestationResult> {
  const now = opts.now ?? new Date();
  const { chainB64, trust } = opts;
  if (chainB64.length < 2 || chainB64.length > 10) fail('certificate chain must have 2 to 10 certificates');
  const chain = chainB64.map((b, i) => {
    try { return new X509Certificate(Buffer.from(b, 'base64')); } catch { return fail(`certificate ${i} is not valid DER`); }
  });

  // 1. Every certificate is signed by the next one, and the last one is a pinned root (signed by itself).
  for (let i = 0; i < chain.length - 1; i++) if (!chain[i]!.verify(chain[i + 1]!.publicKey)) fail(`certificate ${i} is not signed by certificate ${i + 1}`);
  const root = chain[chain.length - 1]!;
  if (!root.verify(root.publicKey)) fail('root is not self-signed');
  const rootSpki = spkiOf(root);
  if (!trust.rootsSpki.some((k) => k.equals(rootSpki))) fail('chain does not end in a trusted Google attestation root');

  // 2. Issuing certificates are within their validity. The leaf's dates come from the device clock, so they are not used.
  for (let i = 1; i < chain.length; i++) {
    const c = chain[i]!;
    if (now < new Date(c.validFrom) || now > new Date(c.validTo)) fail(`certificate ${i} is expired or not yet valid`);
  }

  // 3. No certificate in the chain is revoked.
  const revoked = await trust.revokedSerials();
  if (revoked) for (const c of chain) if (revoked.has(normalizeSerial(c.serialNumber))) fail('a certificate in the chain has been revoked by Google');

  // 4. The leaf certifies exactly the key being enrolled.
  const leaf = chain[0]!;
  const enrolled = createPublicKey({ key: opts.publicKeyDer, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'der' }) as Buffer;
  if (!spkiOf(leaf).equals(enrolled)) fail('attested key does not match the enrolled public key');

  // 5. The key description: hardware-generated, fresh challenge, our app, verified boot.
  const ext = certExtension(Buffer.from(leaf.raw), KEY_DESCRIPTION_OID);
  if (!ext) fail('leaf certificate has no key attestation extension');
  let kd: KeyDescription;
  try { kd = parseKeyDescription(ext!); } catch (e) { return fail(e instanceof AttestationError ? e.reason : `malformed key description (${(e as Error).message})`); }
  const level = SECURITY[kd.attestationSecurityLevel] ?? fail('unknown security level');
  if (level === 'SOFTWARE' || kd.keymasterSecurityLevel === 0) fail('key is not hardware-backed (software attestation)');
  if (kd.challenge.length !== opts.challenge.length || !kd.challenge.equals(opts.challenge)) fail('attestation challenge does not match');

  const origin = kd.hardware.get(TAG.ORIGIN);
  if (!origin || derInt(origin) !== ORIGIN_GENERATED) fail('key was imported, not generated in secure hardware');

  const rot = kd.hardware.get(TAG.ROOT_OF_TRUST);
  if (!rot) fail('no root of trust');
  const rotf = children(expect(rot!, 0, UNIVERSAL.SEQUENCE, 'RootOfTrust'));
  const deviceLocked = derBool(rotf[1]!);
  const bootState = BOOT[derInt(rotf[2]!)] ?? fail('unknown verified boot state');

  const appId = kd.software.get(TAG.APPLICATION_ID) ?? kd.hardware.get(TAG.APPLICATION_ID);
  if (!appId) fail('no attestation application id');
  const want = opts.packageName ?? SHELL_PACKAGE;
  const names = packageNames(appId!);
  if (!names.includes(want)) fail(`key belongs to another app (${names.join(', ').slice(0, 100)})`);

  return { securityLevel: level, attestationVersion: kd.attestationVersion, bootState, deviceLocked, packageName: want, revocationChecked: revoked !== null };
}
