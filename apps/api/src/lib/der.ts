/**
 * Minimal, strict DER reader, enough to read an X.509 certificate's extensions and the Android KeyDescription.
 * Rejects indefinite lengths, non-minimal lengths and trailing bytes. Input is untrusted (it comes from the tablet).
 */
export interface DerNode {
  cls: 0 | 1 | 2 | 3; // universal, application, context-specific, private
  constructed: boolean;
  tag: number;
  /** Content bytes (without tag and length). */
  value: Buffer;
  /** The whole element, header included. */
  raw: Buffer;
}

export function readDer(buf: Buffer, offset = 0): { node: DerNode; next: number } {
  const start = offset;
  const need = (n: number) => { if (offset + n > buf.length) throw new Error('DER: truncated'); };
  need(2);
  const b0 = buf[offset++]!;
  const cls = (b0 >> 6) as DerNode['cls'];
  const constructed = (b0 & 0x20) !== 0;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    for (let i = 0; ; i++) {
      need(1);
      const b = buf[offset++]!;
      if (i === 0 && b === 0x80) throw new Error('DER: non-minimal tag');
      if (i >= 4) throw new Error('DER: tag too large');
      tag = tag * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    if (tag < 31) throw new Error('DER: non-minimal tag');
  }
  need(1);
  const l0 = buf[offset++]!;
  let len: number;
  if (l0 < 0x80) len = l0;
  else {
    const n = l0 & 0x7f;
    if (n === 0) throw new Error('DER: indefinite length');
    if (n > 4) throw new Error('DER: length too large');
    need(n);
    if (buf[offset] === 0) throw new Error('DER: non-minimal length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset++]!;
    if (len < 0x80) throw new Error('DER: non-minimal length');
  }
  if (len > 1 << 20) throw new Error('DER: element too large');
  need(len);
  const value = buf.subarray(offset, offset + len);
  return { node: { cls, constructed, tag, value, raw: buf.subarray(start, offset + len) }, next: offset + len };
}

/** Parses exactly one element; trailing bytes are an error. */
export function parseDer(buf: Buffer): DerNode {
  const { node, next } = readDer(buf, 0);
  if (next !== buf.length) throw new Error('DER: trailing bytes');
  return node;
}

/** Children of a constructed element. */
export function children(n: DerNode): DerNode[] {
  if (!n.constructed) throw new Error('DER: expected a constructed element');
  const out: DerNode[] = [];
  let off = 0;
  while (off < n.value.length) {
    const r = readDer(n.value, off);
    out.push(r.node);
    off = r.next;
  }
  return out;
}

export const UNIVERSAL = { BOOLEAN: 1, INTEGER: 2, BIT_STRING: 3, OCTET_STRING: 4, OID: 6, ENUMERATED: 10, SEQUENCE: 16, SET: 17 } as const;

export function expect(n: DerNode, cls: number, tag: number, what: string): DerNode {
  if (n.cls !== cls || n.tag !== tag) throw new Error(`DER: expected ${what}`);
  return n;
}

/** Small non-negative INTEGER/ENUMERATED as a number (refuses values above 2^48). */
export function derInt(n: DerNode): number {
  if (n.cls !== 0 || (n.tag !== UNIVERSAL.INTEGER && n.tag !== UNIVERSAL.ENUMERATED)) throw new Error('DER: expected INTEGER');
  if (n.value.length === 0 || n.value.length > 7) throw new Error('DER: integer out of range');
  if (n.value[0]! & 0x80) throw new Error('DER: negative integer');
  let v = 0;
  for (const b of n.value) v = v * 256 + b;
  return v;
}

export function derBool(n: DerNode): boolean {
  expect(n, 0, UNIVERSAL.BOOLEAN, 'BOOLEAN');
  if (n.value.length !== 1) throw new Error('DER: bad BOOLEAN');
  return n.value[0] !== 0;
}

export function derOid(n: DerNode): string {
  expect(n, 0, UNIVERSAL.OID, 'OBJECT IDENTIFIER');
  const parts: number[] = [];
  let v = 0;
  for (const b of n.value) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) { parts.push(v); v = 0; }
  }
  if (!parts.length) throw new Error('DER: empty OID');
  const first = parts.shift()!;
  return [first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80, ...parts].join('.');
}
