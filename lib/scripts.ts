import * as bitcoin from 'bitcoinjs-lib';

/** OP_CHECKTEMPLATEVERIFY — repurposed OP_NOP4. bitcoinjs-lib has no constant for it. */
export const OP_CTV = 0xb3;

/**
 * Vault script (locks address V):
 *   <H1>  OP_CTV
 *
 * Anyone can spend, but only into the exact transaction H1 commits to.
 */
export function buildVaultScript(h1: Buffer): Buffer {
  if (h1.length !== 32) throw new Error('CTV hash must be 32 bytes');
  return bitcoin.script.compile([h1, OP_CTV]);
}

/**
 * Trigger script (locks address U):
 *   OP_IF
 *     <delay>  OP_CSV  OP_DROP  <H2>  OP_CTV
 *   OP_ELSE
 *     <panicPubkey>  OP_CHECKSIG
 *   OP_ENDIF
 *
 * IF branch (witness ends with OP_TRUE) → after `delay` blocks, CTV-locked into Tx2.
 * ELSE branch (witness ends with OP_FALSE) → panic key sweeps to cold address.
 */
export function buildTriggerScript(
  h2: Buffer,
  panicPubkey: Buffer,
  delay: number,
): Buffer {
  if (h2.length !== 32) throw new Error('CTV hash must be 32 bytes');
  if (panicPubkey.length !== 33) {
    throw new Error('panic pubkey must be a 33-byte compressed key');
  }
  return bitcoin.script.compile([
    bitcoin.opcodes.OP_IF,
    bitcoin.script.number.encode(delay),
    bitcoin.opcodes.OP_CHECKSEQUENCEVERIFY,
    bitcoin.opcodes.OP_DROP,
    h2,
    OP_CTV,
    bitcoin.opcodes.OP_ELSE,
    panicPubkey,
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_ENDIF,
  ]);
}

/** Wrap a witness script in P2WSH and return the bech32 address + scriptPubKey. */
export function p2wshFrom(
  witnessScript: Buffer,
  network: bitcoin.networks.Network,
): { address: string; output: Buffer } {
  const payment = bitcoin.payments.p2wsh({
    redeem: { output: witnessScript, network },
    network,
  });
  if (!payment.address || !payment.output) {
    throw new Error('failed to derive P2WSH');
  }
  return { address: payment.address, output: Buffer.from(payment.output) };
}
