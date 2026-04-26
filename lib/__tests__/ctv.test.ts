import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { computeCtvHashFull } from '../ctv';
import { parseTx } from './parseTx';

interface VectorEntry {
  desc: Record<string, unknown>;
  hex_tx: string;
  spend_index: number[];
  result: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = join(__dirname, 'ctvhash-vectors.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as unknown[];

// The vectors file has a leading schema description string and a trailing
// "Inserted without comma..." sentinel. Keep only the actual test objects.
const cases = vectors.filter(
  (v): v is VectorEntry => typeof v === 'object' && v !== null && 'hex_tx' in v,
);

describe('BIP-119 CTV reference vectors', () => {
  it('loaded the expected number of vectors', () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  for (const [i, t] of cases.entries()) {
    const label = `vector #${i} ins=${t.desc.Inputs} outs=${t.desc.Outputs} witness=${t.desc.Witness} ss=${t.desc.scriptSigs}`;
    it(label, () => {
      const tx = parseTx(t.hex_tx);
      const scriptSigs = tx.ins.map((inp) => inp.scriptSig);
      const sequences = tx.ins.map((inp) => inp.sequence);
      const outputs = tx.outs.map((o) => ({ value: o.value, script: o.script }));

      expect(t.spend_index.length).toBe(t.result.length);
      for (let k = 0; k < t.spend_index.length; k++) {
        const idx = t.spend_index[k];
        const expected = t.result[k];
        const got = computeCtvHashFull({
          version: tx.version,
          locktime: tx.locktime,
          scriptSigs,
          sequences,
          outputs,
          inputIndex: idx,
        });
        expect(got.toString('hex')).toBe(expected);
      }
    });
  }
});
