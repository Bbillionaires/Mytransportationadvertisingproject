import { kvGet, kvSet } from './store';

export const APP_VERSION = '0.1.0-web';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

interface NativeBridge { postMessage(msg: string): void; onmessage: ((ev: { data: string }) => void) | null }
declare global { interface Window { RMNDevice?: NativeBridge } }

/**
 * Android shell bridge. The shell injects `RMNDevice` only into pages from the configured server origin (WebMessage
 * listener), so advertiser frames never see it. The private key lives in the Android Keystore; the shell only signs
 * canonical /v1/devices/ request strings.
 */
class Native {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private readonly bridge: NativeBridge) {
    bridge.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error ?? 'native bridge error'));
    };
  }
  static get(): Native | null { return window.RMNDevice ? (nativeSingleton ??= new Native(window.RMNDevice)) : null; }
  request<T = any>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('native bridge timeout')); }, 10_000);
      this.bridge.postMessage(JSON.stringify({ id, op, ...extra }));
    });
  }
}
let nativeSingleton: Native | null = null;

type KeyRef = CryptoKeyPair | 'native';

/**
 * Tablet identity. An Ed25519 key pair is generated as NON-EXTRACTABLE and stored in IndexedDB, so the private key can
 * sign but cannot be read by any script. (The Android shell replaces this with a hardware-backed Keystore key.)
 * Every API call is signed over METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body), matching the server's verifier.
 */
export class Device {
  private offsetMs = 0;
  private constructor(public readonly id: string, public readonly serial: string, private readonly keys: KeyRef, public readonly appVersion: string = APP_VERSION) {}

  static async load(): Promise<Device | null> {
    const id = await kvGet<string>('deviceId'), serial = await kvGet<string>('serial'), keys = await kvGet<KeyRef>('keys');
    if (keys === 'native' && !Native.get()) return null; // key lives in the shell; not reachable from a plain browser
    return id && serial && keys ? new Device(id, serial, keys, (await kvGet<string>('appVersion')) ?? APP_VERSION) : null;
  }

  static async enroll(code: string): Promise<Device> {
    const native = Native.get();
    let keys: KeyRef, publicKey: string, serial: string, appVersion = APP_VERSION;
    if (native) {
      const info = await native.request<{ publicKey: string; serial: string; shellVersion?: string }>('info');
      keys = 'native'; publicKey = info.publicKey; serial = info.serial;
      appVersion = `${APP_VERSION}+android-${info.shellVersion ?? '?'}`;
    } else {
      const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
      keys = pair; publicKey = b64(await crypto.subtle.exportKey('spki', pair.publicKey));
      serial = `WEB-${hex(crypto.getRandomValues(new Uint8Array(6)).buffer)}`;
    }
    const res = await fetch('/v1/devices/enroll', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), serial, publicKey, appVersion, osVersion: navigator.userAgent.slice(0, 100) }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.message ?? 'enrollment failed');
    await kvSet('keys', keys); await kvSet('serial', serial); await kvSet('appVersion', appVersion); await kvSet('deviceId', j.deviceId);
    return new Device(j.deviceId, serial, keys, appVersion);
  }

  async call<T = any>(method: 'GET' | 'POST', path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const ts = String(Math.floor((Date.now() + this.offsetMs) / 1000));
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    const signature = await this.sign(new TextEncoder().encode([method, path, ts, nonce, digest].join('\n')));
    const res = await fetch(path, {
      method, body: body || undefined,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': this.id, 'x-device-timestamp': ts, 'x-device-nonce': nonce, 'x-device-signature': signature, ...headers },
    });
    // Track the server clock so signatures stay inside the skew window even if the tablet clock drifts.
    const date = Date.parse(res.headers.get('date') ?? '');
    if (!Number.isNaN(date) && Math.abs(date - Date.now() - this.offsetMs) > 5_000) this.offsetMs = date - Date.now();
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.message ?? res.statusText);
    return j as T;
  }

  get hardwareKey(): boolean { return this.keys === 'native'; }

  private async sign(data: Uint8Array<ArrayBuffer>): Promise<string> {
    if (this.keys === 'native') {
      const native = Native.get();
      if (!native) throw new ApiError(0, 'NATIVE_UNAVAILABLE', 'device key bridge unavailable');
      return (await native.request<{ signature: string }>('sign', { data: btoa(String.fromCharCode(...data)) })).signature;
    }
    return b64(await crypto.subtle.sign('Ed25519', this.keys.privateKey, data));
  }
}
