/**
 * Compares the pinned Google attestation roots (googleAttestationRoots.ts) with Google's live list and checks that the
 * revocation list is reachable. Exit 1 if Google publishes a root we have not pinned (tablets attested by it would be
 * marked FAILED) or a pinned root is no longer published. Run weekly.
 *   npm run jobs:check-attestation-roots -w @rmn/api
 */
import { X509Certificate } from 'node:crypto';
import { cachedGoogleStatusList, spkiOf } from '../modules/devices/attestation.js';
import { GOOGLE_ATTESTATION_ROOTS_PEM } from '../modules/devices/googleAttestationRoots.js';

const ROOTS_URL = 'https://android.googleapis.com/attestation/root';
const fp = (pem: string) => spkiOf(new X509Certificate(pem)).toString('base64');

const res = await fetch(ROOTS_URL, { signal: AbortSignal.timeout(15_000) });
if (!res.ok) { console.error(`FAIL could not fetch ${ROOTS_URL}: ${res.status}`); process.exit(2); }
const live = (await res.json()) as string[];
const pinned = new Set(GOOGLE_ATTESTATION_ROOTS_PEM.map(fp));
const published = new Set(live.map(fp));
const unpinned = [...published].filter((k) => !pinned.has(k));
const withdrawn = [...pinned].filter((k) => !published.has(k));
for (const pem of live) {
  const c = new X509Certificate(pem);
  console.log(`${pinned.has(fp(pem)) ? 'PASS pinned  ' : 'FAIL NEW ROOT'} ${c.subject.replace(/\n/g, ', ')} valid to ${c.validTo}`);
}
for (const k of withdrawn) console.log(`WARN pinned root no longer published by Google (SPKI ${k.slice(0, 24)}…); remove it after checking Google's notice`);
const revoked = await cachedGoogleStatusList()();
console.log(revoked ? `PASS revocation list reachable (${revoked.size} revoked or suspended keys)` : 'WARN revocation list unreachable; enrollments record revocationChecked=false');
if (unpinned.length || withdrawn.length) {
  console.error('Update src/modules/devices/googleAttestationRoots.ts from the live list and redeploy.');
  process.exit(1);
}
