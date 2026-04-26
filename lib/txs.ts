import * as bitcoin from 'bitcoinjs-lib';
import { ECPairInterface } from 'ecpair';
import {
  VaultBlueprint,
  TX_VERSION,
  UNVAULT_SEQUENCE,
  NETWORK,
} from './vault';

export interface OutPoint {
  txid: string;
  vout: number;
}

function reversedHash(txid: string): Buffer {
  return Buffer.from(txid, 'hex').reverse();
}

/**
 * Tx1: spends V → U.
 * Witness: [vault_witness_script]. CTV enforces the entire shape; no signature.
 * sequence = 0xfffffffe (RBF-disabled, locktime-enabled).
 */
export function buildUnvaultTx(bp: VaultBlueprint, funding: OutPoint): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = TX_VERSION;
  tx.locktime = 0;

  tx.addInput(reversedHash(funding.txid), funding.vout, UNVAULT_SEQUENCE);
  tx.addOutput(bp.triggerOutput, Number(bp.unvaultedAmount));

  tx.setWitness(0, [bp.vaultScript]);
  return tx;
}

/**
 * Tx2: spends U → D after CSV delay.
 * Witness: [OP_TRUE (0x01), trigger_witness_script]. CTV enforces the output.
 * sequence MUST equal the delay (otherwise CSV fails). nLockTime = 0.
 */
export function buildCompleteTx(
  bp: VaultBlueprint,
  triggerUtxo: OutPoint,
): bitcoin.Transaction {
  const tx = new bitcoin.Transaction();
  tx.version = TX_VERSION;
  tx.locktime = 0;

  tx.addInput(reversedHash(triggerUtxo.txid), triggerUtxo.vout, bp.params.delay);
  tx.addOutput(bp.hotOutput, Number(bp.completedAmount));

  // OP_IF reads truthy: a non-empty stack item. 0x01 is the canonical "true".
  tx.setWitness(0, [Buffer.from([0x01]), bp.triggerScript]);
  return tx;
}

export interface PanicParams {
  triggerUtxo: OutPoint;
  /** Value of the UTXO at U (sats). Needed for the BIP-143 sighash. */
  triggerValueSats: bigint;
  coldAddress: string;
  panicKey: ECPairInterface;
  /** Override fee for this tx; defaults to blueprint fee. */
  feeSats?: bigint;
}

/**
 * Tx3: spends U → C, signed by the panic key (ELSE branch).
 * Witness: [sig_with_hashtype, OP_FALSE (empty), trigger_witness_script].
 */
export function buildPanicTx(bp: VaultBlueprint, p: PanicParams): bitcoin.Transaction {
  const fee = p.feeSats ?? bp.params.feeSats;
  if (p.triggerValueSats <= fee) {
    throw new Error(`trigger value ${p.triggerValueSats} <= fee ${fee}`);
  }
  const sweepAmount = p.triggerValueSats - fee;
  const coldOutput = bitcoin.address.toOutputScript(p.coldAddress, NETWORK);

  const tx = new bitcoin.Transaction();
  tx.version = TX_VERSION;
  tx.locktime = 0;

  // No CSV needed for panic path; sequence non-final to keep BIP-125 disabled.
  tx.addInput(reversedHash(p.triggerUtxo.txid), p.triggerUtxo.vout, UNVAULT_SEQUENCE);
  tx.addOutput(coldOutput, Number(sweepAmount));

  // BIP-143 sighash for the P2WSH input.
  const sighash = tx.hashForWitnessV0(
    0,
    bp.triggerScript,
    Number(p.triggerValueSats),
    bitcoin.Transaction.SIGHASH_ALL,
  );
  const rawSig = Buffer.from(p.panicKey.sign(sighash));
  const sigWithHashType = bitcoin.script.signature.encode(
    rawSig,
    bitcoin.Transaction.SIGHASH_ALL,
  );

  tx.setWitness(0, [sigWithHashType, Buffer.alloc(0), bp.triggerScript]);
  return tx;
}
