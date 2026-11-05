/**
 * Builds SYNTHETIC Android key attestation chains for tests: a test root → intermediate → leaf whose KeyDescription
 * extension follows Android's schema. Real chains are rooted in Google's keys, which tests cannot sign with, so tests
 * trust this synthetic root instead (AttestationTrust is injectable).
 */
import { generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { spkiOf, type AttestationTrust } from '../src/modules/devices/attestation.js';

const len = (n: number) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: Buffer | number, ...content: Buffer[]) => {
  const c = Buffer.concat(content);
  return Buffer.concat([typeof tag === 'number' ? Buffer.from([tag]) : tag, len(c.length), c]);
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);
const set = (...c: Buffer[]) => tlv(0x31, ...c);
const int = (n: number) => { const b: number[] = []; do { b.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0); if (b[0]! & 0x80) b.unshift(0); return tlv(0x02, Buffer.from(b)); };
const intBytes = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const enumerated = (n: number) => tlv(0x0a, Buffer.from([n]));
const octets = (b: Buffer | string) => tlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(b));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const oid = (s: string) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) { const parts = [n & 0x7f]; let v = Math.floor(n / 128); while (v > 0) { parts.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(...parts); }
  return tlv(0x06, Buffer.from(out));
};
/** Context-specific constructed [n] EXPLICIT, including the high-tag form Android uses (e.g. [702]). */
const ctx = (n: number, ...c: Buffer[]) => {
  if (n < 31) return tlv(0xa0 | n, ...c);
  const t: number[] = [n & 0x7f]; let v = Math.floor(n / 128);
  while (v > 0) { t.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  return tlv(Buffer.from([0xbf, ...t]), ...c);
};
const time = (d: Date) => {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
};
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
let serialCounter = 0x1000;

function cert(o: { subject: string; issuer: string; publicKey: KeyObject; signer: KeyObject; serial?: number; notBefore?: Date; notAfter?: Date; extensions?: Buffer[] }): Buffer {
  const serial = o.serial ?? serialCounter++;
  const tbs = seq(
    ctx(0, int(2)), intBytes(Buffer.from(serial.toString(16).padStart(Math.ceil(serial.toString(16).length / 2) * 2, '0'), 'hex')), ECDSA_SHA256, name(o.issuer),
    seq(time(o.notBefore ?? new Date(Date.now() - 86_400_000)), time(o.notAfter ?? new Date(Date.now() + 365 * 86_400_000))), name(o.subject),
    o.publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    ...(o.extensions?.length ? [ctx(3, seq(...o.extensions))] : []),
  );
  const sig = sign('sha256', tbs, o.signer);
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sig));
}

export interface KeyDescriptionOpts {
  challenge: Buffer;
  securityLevel?: number; // 0 software, 1 TEE, 2 StrongBox
  packageName?: string;
  origin?: number; // 0 generated, 2 imported
  bootState?: number; // 0 verified … 3 failed
  deviceLocked?: boolean;
  omitRootOfTrust?: boolean;
}

export function keyDescription(o: KeyDescriptionOpts): Buffer {
  const level = o.securityLevel ?? 1;
  const appId = seq(set(seq(octets(o.packageName ?? 'net.ridesharemedia.shell'), int(1))), set(octets(Buffer.alloc(32, 7))));
  const software = seq(ctx(709, octets(appId)));
  const hardware = seq(
    ctx(1, set(int(2))), ctx(2, int(3)), ctx(10, int(1)),
    ctx(702, int(o.origin ?? 0)),
    ...(o.omitRootOfTrust ? [] : [ctx(704, seq(octets(Buffer.alloc(32, 1)), bool(o.deviceLocked ?? true), enumerated(o.bootState ?? 0), octets(Buffer.alloc(32, 2))))]),
  );
  return seq(int(300), enumerated(level), int(300), enumerated(level), octets(o.challenge), octets(Buffer.alloc(0)), software, hardware);
}

export class TestAttestationCa {
  readonly root = ec();
  readonly intermediate = ec();
  readonly rootCert: Buffer;
  readonly intermediateCert: Buffer;
  readonly intermediateSerial: number;
  revoked = new Set<string>();

  constructor(opts: { intermediateNotAfter?: Date } = {}) {
    this.rootCert = cert({ subject: 'Synthetic Attestation Root', issuer: 'Synthetic Attestation Root', publicKey: this.root.publicKey, signer: this.root.privateKey });
    this.intermediateSerial = serialCounter++;
    this.intermediateCert = cert({ subject: 'Synthetic Attestation Intermediate', issuer: 'Synthetic Attestation Root', publicKey: this.intermediate.publicKey,
      signer: this.root.privateKey, serial: this.intermediateSerial, notAfter: opts.intermediateNotAfter });
  }

  trust(): AttestationTrust {
    return { rootsSpki: [spkiOf(new X509Certificate(this.rootCert))], revokedSerials: async () => this.revoked };
  }

  /** A device key plus its attestation chain (leaf, intermediate, root), base64 DER as the shell sends it. */
  attest(kd: KeyDescriptionOpts, opts: { devicePublicKey?: KeyObject; attestedKey?: KeyObject } = {}) {
    const device = opts.devicePublicKey ? { publicKey: opts.devicePublicKey } : ec();
    const leaf = cert({ subject: 'Android Keystore Key', issuer: 'Synthetic Attestation Intermediate', publicKey: opts.attestedKey ?? device.publicKey,
      signer: this.intermediate.privateKey, notBefore: new Date(0), notAfter: new Date('2106-02-07T06:28:15Z'),
      extensions: [seq(oid('1.3.6.1.4.1.11129.2.1.17'), octets(keyDescription(kd)))] });
    return {
      publicKeyB64: (device.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
      chain: [leaf, this.intermediateCert, this.rootCert].map((c) => c.toString('base64')),
    };
  }
}
