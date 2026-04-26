/**
 * Mutinynet Esplora REST client.
 * Docs: https://github.com/Blockstream/esplora/blob/master/API.md
 */

export const MUTINYNET_API = 'https://mutinynet.com/api';
export const MUTINYNET_EXPLORER = 'https://mutinynet.com';
export const MUTINYNET_FAUCET = 'https://faucet.mutinynet.com/';

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  status: EsploraTxStatus;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${MUTINYNET_API}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Esplora GET ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

async function getText(path: string): Promise<string> {
  const res = await fetch(`${MUTINYNET_API}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Esplora GET ${path} failed: ${res.status} ${body}`);
  }
  return res.text();
}

export async function getTipHeight(): Promise<number> {
  const txt = await getText('/blocks/tip/height');
  return parseInt(txt.trim(), 10);
}

export async function getUtxos(address: string): Promise<EsploraUtxo[]> {
  return get<EsploraUtxo[]>(`/address/${address}/utxo`);
}

export async function getAddressTxs(address: string): Promise<EsploraTx[]> {
  return get<EsploraTx[]>(`/address/${address}/txs`);
}

export async function getTx(txid: string): Promise<EsploraTx> {
  return get<EsploraTx>(`/tx/${txid}`);
}

export async function getTxStatus(txid: string): Promise<EsploraTxStatus> {
  return get<EsploraTxStatus>(`/tx/${txid}/status`);
}

/** POST raw tx hex; returns txid on success. */
export async function broadcastTx(rawHex: string): Promise<string> {
  const res = await fetch(`${MUTINYNET_API}/tx`, {
    method: 'POST',
    body: rawHex,
    headers: { 'content-type': 'text/plain' },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`broadcast failed: ${res.status} ${body}`);
  return body.trim();
}

export function explorerTxUrl(txid: string): string {
  return `${MUTINYNET_EXPLORER}/tx/${txid}`;
}

export function explorerAddressUrl(address: string): string {
  return `${MUTINYNET_EXPLORER}/address/${address}`;
}
