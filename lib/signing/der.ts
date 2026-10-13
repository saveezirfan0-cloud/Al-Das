/**
 * Minimal DER (ASN.1) reading and writing for the signing code (pure). Only what CMS, X.509 and PAdES need: definite
 * lengths, single-byte tags. Anything else (BER indefinite lengths, high tag numbers) is refused, so a verifier fails
 * closed on input it does not understand.
 */

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
} as const;

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

export type DerNode = {
  tag: number;
  /** Offset of the tag byte in the buffer. */
  start: number;
  headerLength: number;
  length: number;
  /** Offset just past the value. */
  end: number;
  constructed: boolean;
};

/** Reads one TLV at `offset`. Throws DerError on anything malformed or out of range. */
export function readNode(buf: Uint8Array, offset = 0): DerNode {
  if (offset + 2 > buf.length) throw new DerError("truncated");
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError("high tag numbers are not supported");
  let len = buf[offset + 1];
  let header = 2;
  if (len === 0x80) throw new DerError("indefinite length is not DER");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) throw new DerError("length too large");
    if (offset + 2 + n > buf.length) throw new DerError("truncated");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
    header += n;
  }
  const end = offset + header + len;
  if (end > buf.length) throw new DerError("truncated");
  return {
    tag,
    start: offset,
    headerLength: header,
    length: len,
    end,
    constructed: (tag & 0x20) !== 0,
  };
}

/** The value bytes of a node. */
export function valueOf(buf: Uint8Array, n: DerNode): Buffer {
  return Buffer.from(buf.subarray(n.start + n.headerLength, n.end));
}

/** The whole TLV of a node. */
export function bytesOf(buf: Uint8Array, n: DerNode): Buffer {
  return Buffer.from(buf.subarray(n.start, n.end));
}

/** The children of a constructed node. */
export function childrenOf(buf: Uint8Array, n: DerNode): DerNode[] {
  if (!n.constructed) throw new DerError("not a constructed value");
  const out: DerNode[] = [];
  let at = n.start + n.headerLength;
  while (at < n.end) {
    const c = readNode(buf, at);
    if (c.end > n.end) throw new DerError("child overruns its parent");
    out.push(c);
    at = c.end;
  }
  return out;
}

export function expectTag(n: DerNode | undefined, tag: number, what: string): DerNode {
  if (!n || n.tag !== tag) throw new DerError(`expected ${what}`);
  return n;
}

export function decodeOid(value: Uint8Array): string {
  if (value.length === 0) throw new DerError("empty OID");
  const parts: number[] = [];
  let acc = 0;
  for (let i = 0; i < value.length; i++) {
    acc = acc * 128 + (value[i] & 0x7f);
    if (!(value[i] & 0x80)) {
      parts.push(acc);
      acc = 0;
    }
  }
  const first = parts.shift()!;
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...parts].join(".");
}

/** Decodes a UTCTime or GeneralizedTime value. */
export function decodeTime(tag: number, value: Uint8Array): Date {
  const s = Buffer.from(value).toString("latin1");
  let m: RegExpMatchArray | null;
  if (tag === TAG.UTC_TIME) {
    m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new DerError("bad UTCTime");
    const yy = Number(m[1]);
    return new Date(
      Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
    );
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
  if (!m) throw new DerError("bad GeneralizedTime");
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------------

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | out.length, ...out]);
}

export function tlv(tag: number, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), Buffer.from(content)]);
}

export const seq = (...items: Uint8Array[]) => tlv(TAG.SEQUENCE, Buffer.concat(items));

/** DER SET OF: the elements are sorted by their encoding (X.690 11.6). */
export function setOf(items: Uint8Array[], tag: number = TAG.SET): Buffer {
  const sorted = [...items].map((x) => Buffer.from(x)).sort(Buffer.compare);
  return tlv(tag, Buffer.concat(sorted));
}

export function oid(dotted: string): Buffer {
  const p = dotted.split(".").map(Number);
  if (p.length < 2 || p.some((x) => !Number.isInteger(x) || x < 0)) throw new DerError("bad OID");
  const out: number[] = [];
  const push = (v: number) => {
    const bytes = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      bytes.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...bytes);
  };
  push(p[0] * 40 + p[1]);
  for (const v of p.slice(2)) push(v);
  return tlv(TAG.OID, Buffer.from(out));
}

export function int(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 127) throw new DerError("small ints only");
  return tlv(TAG.INTEGER, Buffer.from([value]));
}

export const octets = (b: Uint8Array) => tlv(TAG.OCTET_STRING, b);
export const nul = () => Buffer.from([TAG.NULL, 0x00]);

/** A context-specific constructed tag [n] around already-encoded content (explicit tagging or an implicit SET/SEQUENCE). */
export const ctx = (n: number, content: Uint8Array) => tlv(0xa0 | n, content);

/** UTCTime between 1950 and 2049, GeneralizedTime otherwise (RFC 5280 4.1.2.5), whole seconds. */
export function time(d: Date): Buffer {
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y < 2050)
    return tlv(TAG.UTC_TIME, Buffer.from(`${p(y % 100)}${rest}`, "latin1"));
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(`${p(y, 4)}${rest}`, "latin1"));
}
