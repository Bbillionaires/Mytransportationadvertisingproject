/** Identify container type from magic bytes. The client's declared content type is never trusted. */
export type Detected = 'video/mp4' | 'video/quicktime' | 'video/webm' | 'image/png' | 'image/jpeg';

export function sniff(head: Buffer): Detected | null {
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  return null;
}

export const isVideo = (t: Detected) => t.startsWith('video/');
