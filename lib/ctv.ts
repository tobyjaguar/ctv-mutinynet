import { createHash } from 'crypto';

const sha256 = (buf: Buffer): Buffer =>
  createHash('sha256').update(buf).digest();

function writeUInt32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function writeInt32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n | 0, 0);
  return b;
}

function writeUInt64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function varintEncode(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  throw new Error('varint too large for our use');
}

export interface CtvOutput {
  value: bigint;
  script: Buffer;
}

export interface CtvParamsFull {
  version: number;
  locktime: number;
  /** Optional. When provided AND any element is non-empty, scriptSigsHash is included. */
  scriptSigs?: Buffer[];
  sequences: number[];
  outputs: CtvOutput[];
  inputIndex: number;
}

/**
 * BIP-119 DefaultCheckTemplateVerifyHash.
 * General form that supports the optional scriptSigsHash field, used for testing
 * against BIP-119 reference vectors that include non-SegWit transactions.
 */
export function computeCtvHashFull(p: CtvParamsFull): Buffer {
  const parts: Buffer[] = [];
  parts.push(writeInt32LE(p.version));
  parts.push(writeUInt32LE(p.locktime));

  const scriptSigs = p.scriptSigs ?? [];
  const anyNonEmpty = scriptSigs.some((s) => s.length > 0);
  if (anyNonEmpty) {
    const ssBuf = Buffer.concat(
      scriptSigs.map((s) => Buffer.concat([varintEncode(s.length), Buffer.from(s)])),
    );
    parts.push(sha256(ssBuf));
  }

  parts.push(writeUInt32LE(p.sequences.length));
  const seqBuf = Buffer.concat(p.sequences.map((s) => writeUInt32LE(s)));
  parts.push(sha256(seqBuf));

  parts.push(writeUInt32LE(p.outputs.length));
  const outBuf = Buffer.concat(
    p.outputs.map((o) =>
      Buffer.concat([
        writeUInt64LE(o.value),
        varintEncode(o.script.length),
        Buffer.from(o.script),
      ]),
    ),
  );
  parts.push(sha256(outBuf));

  parts.push(writeUInt32LE(p.inputIndex));

  return sha256(Buffer.concat(parts));
}

/**
 * SegWit-only convenience: matches the spec signature in the project doc.
 * scriptSigs are assumed empty (P2WSH inputs), so scriptSigsHash is omitted.
 */
export function computeCtvHash(
  version: number,
  locktime: number,
  sequences: number[],
  outputs: CtvOutput[],
  inputIndex: number,
): Buffer {
  return computeCtvHashFull({ version, locktime, sequences, outputs, inputIndex });
}
