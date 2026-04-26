/**
 * Thin client for the public Mutiny RPC HTTP facade
 * (a JSON-RPC proxy in front of a Bitcoin Core compatible signet node).
 *
 * Used in the smoke script for pre-flight tx validation via testmempoolaccept,
 * which Esplora doesn't expose.
 */

export const MUTINY_RPC_URL = 'http://3.231.31.216:3000/v1/rpc';

interface RpcEnvelope<T> {
  result: T | null;
  error: { code: number; message: string } | null;
  id: string;
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(MUTINY_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
    cache: 'no-store',
  });
  const body = (await res.json()) as RpcEnvelope<T>;
  if (body.error) {
    throw new Error(`RPC ${method} failed: [${body.error.code}] ${body.error.message}`);
  }
  return body.result as T;
}

export interface MempoolAcceptResult {
  txid: string;
  wtxid?: string;
  allowed: boolean;
  vsize?: number;
  fees?: { base: number };
  ['reject-reason']?: string;
}

/**
 * Returns the single-tx test result. Throws if the node rejects the call,
 * but a not-allowed tx (allowed=false) returns normally — the caller
 * should check `.allowed` and inspect `reject-reason`.
 */
export async function testMempoolAccept(rawHex: string): Promise<MempoolAcceptResult> {
  const arr = await rpc<MempoolAcceptResult[]>('testmempoolaccept', [[rawHex]]);
  return arr[0];
}

export async function getBlockCount(): Promise<number> {
  return rpc<number>('getblockcount');
}
