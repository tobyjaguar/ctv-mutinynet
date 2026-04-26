import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory, ECPairInterface } from 'ecpair';
import { computeCtvHash } from './ctv';
import { buildVaultScript, buildTriggerScript, p2wshFrom } from './scripts';

bitcoin.initEccLib(ecc);
export const ECPair = ECPairFactory(ecc);

/** Mutinynet uses the testnet/signet bech32 HRP (`tb1...`). */
export const NETWORK = bitcoin.networks.testnet;

export const DELAY_BLOCKS = 3;           // ~1.5 min on mutinynet (30s blocks) — demo-friendly
export const DEFAULT_FEE_SATS = 200n;    // generous absolute fee per tx
export const UNVAULT_SEQUENCE = 0xfffffffe;
export const TX_VERSION = 2;

export interface VaultParams {
  /** Funding amount the vault address V expects (in sats). Must match exactly. */
  amountSats: bigint;
  /** Final destination after the timelock. */
  hotAddress: string;
  /** Compressed (33-byte) panic pubkey. */
  panicPubkey: Buffer;
  /** CSV delay in blocks. Defaults to DELAY_BLOCKS (10). */
  delay?: number;
  /** Per-tx fee in sats. Defaults to DEFAULT_FEE_SATS (200). */
  feeSats?: bigint;
}

export interface VaultBlueprint {
  params: Required<VaultParams>;
  vaultAddress: string;
  vaultScript: Buffer;
  vaultOutput: Buffer;
  triggerAddress: string;
  triggerScript: Buffer;
  triggerOutput: Buffer;
  hotOutput: Buffer;
  /** Amount that lands at U after the Unvault tx pays the fee. */
  unvaultedAmount: bigint;
  /** Amount that lands at D after the Complete tx pays the fee. */
  completedAmount: bigint;
  /** BIP-119 hash committed in the vault script. */
  h1: Buffer;
  /** BIP-119 hash committed in the trigger script's IF branch. */
  h2: Buffer;
}

/**
 * Derive the full vault blueprint deterministically from params.
 * Order matters: H2 → trigger script → U → H1 → vault script → V.
 */
export function buildVault(p: VaultParams): VaultBlueprint {
  const delay = p.delay ?? DELAY_BLOCKS;
  const feeSats = p.feeSats ?? DEFAULT_FEE_SATS;

  if (p.panicPubkey.length !== 33) {
    throw new Error('panicPubkey must be 33 bytes (compressed)');
  }
  if (p.amountSats <= feeSats * 2n) {
    throw new Error(`amountSats must exceed 2x fee (${feeSats * 2n})`);
  }

  const hotOutput = bitcoin.address.toOutputScript(p.hotAddress, NETWORK);

  // Tx2 (Complete) commits to: U → D, paying (amount - 2*fee) to hot.
  // Sequence MUST equal the CSV delay or CSV will fail.
  const completedAmount = p.amountSats - feeSats * 2n;
  const h2 = computeCtvHash(
    TX_VERSION,
    0, // locktime
    [delay], // CSV-matching sequence
    [{ value: completedAmount, script: hotOutput }],
    0,
  );

  const triggerScript = buildTriggerScript(h2, p.panicPubkey, delay);
  const trigger = p2wshFrom(triggerScript, NETWORK);

  // Tx1 (Unvault) commits to: V → U, paying (amount - fee) to trigger.
  const unvaultedAmount = p.amountSats - feeSats;
  const h1 = computeCtvHash(
    TX_VERSION,
    0,
    [UNVAULT_SEQUENCE],
    [{ value: unvaultedAmount, script: trigger.output }],
    0,
  );

  const vaultScript = buildVaultScript(h1);
  const vault = p2wshFrom(vaultScript, NETWORK);

  return {
    params: { ...p, delay, feeSats },
    vaultAddress: vault.address,
    vaultScript,
    vaultOutput: vault.output,
    triggerAddress: trigger.address,
    triggerScript,
    triggerOutput: trigger.output,
    hotOutput,
    unvaultedAmount,
    completedAmount,
    h1,
    h2,
  };
}

/** Generate a fresh keypair with a Buffer publicKey (handles ecpair v3 returning Uint8Array). */
export function generateKeyPair(): {
  keyPair: ECPairInterface;
  pubkey: Buffer;
  wif: string;
} {
  const keyPair = ECPair.makeRandom({ network: NETWORK });
  return {
    keyPair,
    pubkey: Buffer.from(keyPair.publicKey),
    wif: keyPair.toWIF(),
  };
}

export function keyPairFromWIF(wif: string): ECPairInterface {
  return ECPair.fromWIF(wif, NETWORK);
}

/** Derive a P2WPKH address from a compressed pubkey, used for ephemeral hot/cold addresses. */
export function p2wpkhAddress(pubkey: Buffer): string {
  const payment = bitcoin.payments.p2wpkh({ pubkey, network: NETWORK });
  if (!payment.address) throw new Error('failed to derive p2wpkh');
  return payment.address;
}
