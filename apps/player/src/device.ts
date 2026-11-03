import { kvGet, kvSet } from './store';

export const APP_VERSION = '0.1.0-web';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Tablet identity. An Ed25519 key pair is generated as NON-EXTRACTABLE and stored in IndexedDB, so the private key can
 * sign but cannot be read by any script. (The Android shell replaces this with a hardware-backed Keystore key.)
 * Every API call is signed over METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body), matching the server's verifier.
 */
export class Device {
  private offsetMs = 0;
  private constructor(public readonly id: string, public readonly serial: string, private readonly keys: CryptoKeyPair) {}

  static async load(): Promise<Device | null> {
    const id = await kvGet<string>('deviceId'), serial = await kvGet<string>('serial'), keys = await kvGet<CryptoKeyPair>('keys');
    return id && serial && keys ? new Device(id, serial, keys) : null;
  }

  static async enroll(code: string): Promise<Device> {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
    const serial = `WEB-${hex(crypto.getRandomValues(new Uint8Array(6)).buffer)}`;
    const res = await fetch('/v1/devices/enroll', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), serial, publicKey: b64(spki), appVersion: APP_VERSION, osVersion: navigator.userAgent.slice(0, 100) }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.message ?? 'enrollment failed');
    await kvSet('keys', keys); await kvSet('serial', serial); await kvSet('deviceId', j.deviceId);
    return new Device(j.deviceId, serial, keys);
  }

  async call<T = any>(method: 'GET' | 'POST', path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const ts = String(Math.floor((Date.now() + this.offsetMs) / 1000));
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    const sig = await crypto.subtle.sign('Ed25519', this.keys.privateKey, new TextEncoder().encode([method, path, ts, nonce, digest].join('\n')));
    const res = await fetch(path, {
      method, body: body || undefined,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': this.id, 'x-device-timestamp': ts, 'x-device-nonce': nonce, 'x-device-signature': b64(sig), ...headers },
    });
    // Track the server clock so signatures stay inside the skew window even if the tablet clock drifts.
    const date = Date.parse(res.headers.get('date') ?? '');
    if (!Number.isNaN(date) && Math.abs(date - Date.now() - this.offsetMs) > 5_000) this.offsetMs = date - Date.now();
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.message ?? res.statusText);
    return j as T;
  }
}
