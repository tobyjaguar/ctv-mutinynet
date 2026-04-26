/**
 * Minimal Bitcoin transaction parser for CTV vector tests.
 * Unlike bitcoinjs-lib, this reads output amounts as BigInt so the BIP-119
 * reference vectors (which contain random uint64 values > 2^53) round-trip
 * correctly.
 */

export interface ParsedInput {
  scriptSig: Buffer;
  sequence: number;
}

export interface ParsedOutput {
  value: bigint;
  script: Buffer;
}

export interface ParsedTx {
  version: number;
  locktime: number;
  ins: ParsedInput[];
  outs: ParsedOutput[];
}

class Reader {
  private offset = 0;
  constructor(private buf: Buffer) {}

  readBytes(n: number): Buffer {
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return Buffer.from(out);
  }
  readUInt32LE(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  readInt32LE(): number {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  readUInt64LEBig(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  readVarInt(): number {
    const first = this.buf[this.offset];
    this.offset += 1;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = this.buf.readUInt16LE(this.offset);
      this.offset += 2;
      return v;
    }
    if (first === 0xfe) {
      const v = this.buf.readUInt32LE(this.offset);
      this.offset += 4;
      return v;
    }
    // 0xff: 8-byte varint. We don't expect counts that big.
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return Number(v);
  }
  peek(n: number): number {
    return this.buf[this.offset + n];
  }
  remaining(): number {
    return this.buf.length - this.offset;
  }
}

export function parseTx(hex: string): ParsedTx {
  const r = new Reader(Buffer.from(hex, 'hex'));
  const version = r.readInt32LE();

  // SegWit marker/flag detection
  let hasWitness = false;
  if (r.peek(0) === 0x00 && r.peek(1) === 0x01) {
    hasWitness = true;
    r.readBytes(2);
  }

  const nIn = r.readVarInt();
  const ins: ParsedInput[] = [];
  for (let i = 0; i < nIn; i++) {
    r.readBytes(32); // prev txid
    r.readUInt32LE(); // prev vout
    const slen = r.readVarInt();
    const scriptSig = r.readBytes(slen);
    const sequence = r.readUInt32LE();
    ins.push({ scriptSig, sequence });
  }

  const nOut = r.readVarInt();
  const outs: ParsedOutput[] = [];
  for (let i = 0; i < nOut; i++) {
    const value = r.readUInt64LEBig();
    const slen = r.readVarInt();
    const script = r.readBytes(slen);
    outs.push({ value, script });
  }

  if (hasWitness) {
    for (let i = 0; i < nIn; i++) {
      const stackLen = r.readVarInt();
      for (let j = 0; j < stackLen; j++) {
        const itemLen = r.readVarInt();
        r.readBytes(itemLen);
      }
    }
  }

  const locktime = r.readUInt32LE();
  return { version, locktime, ins, outs };
}
