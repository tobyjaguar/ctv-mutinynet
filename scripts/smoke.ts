/**
 * BitVault smoke test — runs the full V → U → (D | C) flow against Mutinynet.
 *
 * Usage:
 *   npm run smoke                       # generate fresh vault, walk happy path
 *   npm run smoke -- --panic            # take the panic path instead
 *   npm run smoke -- --amount 200000    # custom funding amount (sats)
 *   npm run smoke -- --resume <wif>     # reuse a panic key from a prior run
 *
 * Each broadcast is preflight-checked with testmempoolaccept against the
 * public Mutiny RPC facade so byte-level errors surface before we burn the UTXO.
 */

import {
  buildVault,
  generateKeyPair,
  keyPairFromWIF,
  p2wpkhAddress,
  NETWORK,
} from '../lib/vault';
import {
  buildUnvaultTx,
  buildCompleteTx,
  buildPanicTx,
} from '../lib/txs';
import {
  getTipHeight,
  getUtxos,
  broadcastTx,
  explorerTxUrl,
  explorerAddressUrl,
  MUTINYNET_FAUCET,
  EsploraUtxo,
} from '../lib/esplora';
import { testMempoolAccept } from '../lib/mutinyRpc';

interface Args {
  amount: bigint;
  panic: boolean;
  resumeWif?: string;
  hot?: string;
  cold?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { amount: 100_000n, panic: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--panic') args.panic = true;
    else if (a === '--amount') args.amount = BigInt(argv[++i]);
    else if (a === '--resume') args.resumeWif = argv[++i];
    else if (a === '--hot') args.hot = argv[++i];
    else if (a === '--cold') args.cold = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(__filename + ' [--amount N] [--panic] [--resume WIF] [--hot ADDR] [--cold ADDR]');
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rule(label: string) {
  console.log('\n' + '─'.repeat(8) + ' ' + label + ' ' + '─'.repeat(Math.max(0, 60 - label.length)));
}

async function pollForUtxo(addr: string, intervalMs = 5000): Promise<EsploraUtxo> {
  process.stdout.write(`polling ${addr.slice(0, 14)}…`);
  for (;;) {
    const utxos = await getUtxos(addr);
    if (utxos.length > 0) {
      process.stdout.write(' ✓\n');
      return utxos[0];
    }
    process.stdout.write('.');
    await sleep(intervalMs);
  }
}

async function waitForConfirmation(addr: string, txid: string, intervalMs = 5000): Promise<EsploraUtxo> {
  process.stdout.write(`waiting for ${txid.slice(0, 12)} to confirm`);
  for (;;) {
    const utxos = await getUtxos(addr);
    const match = utxos.find((u) => u.txid === txid);
    if (match?.status.confirmed) {
      process.stdout.write(' ✓\n');
      return match;
    }
    process.stdout.write('.');
    await sleep(intervalMs);
  }
}

async function preflight(label: string, rawHex: string) {
  const r = await testMempoolAccept(rawHex);
  if (!r.allowed) {
    console.error(`✗ preflight rejected ${label}: ${r['reject-reason']}`);
    console.error('  raw:', rawHex);
    throw new Error('preflight failed');
  }
  console.log(`✓ preflight OK (${label}) txid=${r.txid} vsize=${r.vsize}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  rule('keys');
  let panicWif: string;
  let panicKeyPair;
  if (args.resumeWif) {
    panicKeyPair = keyPairFromWIF(args.resumeWif);
    panicWif = args.resumeWif;
    console.log('reusing panic key from --resume');
  } else {
    const k = generateKeyPair();
    panicKeyPair = k.keyPair;
    panicWif = k.wif;
    console.log('panic key WIF:', panicWif, '(SAVE THIS to --resume on retry)');
  }
  const panicPubkey = Buffer.from(panicKeyPair.publicKey);

  // Ephemeral hot/cold P2WPKH addresses if not provided.
  const hot = args.hot ?? p2wpkhAddress(Buffer.from(generateKeyPair().pubkey));
  const cold = args.cold ?? p2wpkhAddress(Buffer.from(generateKeyPair().pubkey));
  console.log('hot  D:', hot);
  console.log('cold C:', cold);

  rule('blueprint');
  const bp = buildVault({
    amountSats: args.amount,
    hotAddress: hot,
    panicPubkey,
  });
  console.log('vault   V:', bp.vaultAddress);
  console.log('trigger U:', bp.triggerAddress);
  console.log('amount   :', args.amount.toString(), 'sats');
  console.log('after Tx1:', bp.unvaultedAmount.toString(), 'sats at U');
  console.log('after Tx2:', bp.completedAmount.toString(), 'sats at D');
  console.log('H1:', bp.h1.toString('hex'));
  console.log('H2:', bp.h2.toString('hex'));
  console.log('vault scriptPubKey:', bp.vaultOutput.toString('hex'));

  rule('fund');
  console.log(`Send EXACTLY ${args.amount.toString()} sats to:`);
  console.log('   ', bp.vaultAddress);
  console.log('Faucet:', MUTINYNET_FAUCET);
  console.log('Vault address page:', explorerAddressUrl(bp.vaultAddress));

  const fundingUtxo = await pollForUtxo(bp.vaultAddress);
  if (BigInt(fundingUtxo.value) !== args.amount) {
    throw new Error(
      `funding mismatch: vault expects ${args.amount} but got ${fundingUtxo.value}. ` +
        `CTV will reject. Re-fund or rerun with --amount ${fundingUtxo.value}`,
    );
  }
  console.log('funded:', explorerTxUrl(fundingUtxo.txid));

  rule('Tx1: Unvault (V → U)');
  const unvault = buildUnvaultTx(bp, { txid: fundingUtxo.txid, vout: fundingUtxo.vout });
  const unvaultHex = unvault.toHex();
  console.log('raw:', unvaultHex);
  await preflight('unvault', unvaultHex);
  const unvaultTxid = await broadcastTx(unvaultHex);
  console.log('broadcast:', explorerTxUrl(unvaultTxid));

  const triggerUtxo = await waitForConfirmation(bp.triggerAddress, unvaultTxid);
  const triggerBlock = triggerUtxo.status.block_height!;
  const targetHeight = triggerBlock + bp.params.delay;
  console.log(`trigger confirmed in block ${triggerBlock}; need tip >= ${targetHeight}`);

  if (args.panic) {
    rule('Tx3: Panic (U → C)');
    const panic = buildPanicTx(bp, {
      triggerUtxo: { txid: triggerUtxo.txid, vout: triggerUtxo.vout },
      triggerValueSats: BigInt(triggerUtxo.value),
      coldAddress: cold,
      panicKey: panicKeyPair,
    });
    const panicHex = panic.toHex();
    console.log('raw:', panicHex);
    await preflight('panic', panicHex);
    const panicTxid = await broadcastTx(panicHex);
    console.log('broadcast:', explorerTxUrl(panicTxid));
    console.log(`✓ funds swept to cold address ${cold}`);
    return;
  }

  rule('countdown');
  for (;;) {
    const tip = await getTipHeight();
    const remaining = targetHeight - tip;
    if (remaining <= 0) {
      process.stdout.write(' ✓ ready\n');
      break;
    }
    process.stdout.write(`tip=${tip} blocks_remaining=${remaining}\r`);
    await sleep(5000);
  }

  rule('Tx2: Complete (U → D)');
  const complete = buildCompleteTx(bp, { txid: triggerUtxo.txid, vout: triggerUtxo.vout });
  const completeHex = complete.toHex();
  console.log('raw:', completeHex);
  await preflight('complete', completeHex);
  const completeTxid = await broadcastTx(completeHex);
  console.log('broadcast:', explorerTxUrl(completeTxid));
  console.log(`✓ funds released to hot address ${hot}`);
}

main().catch((err) => {
  console.error('\n✗ smoke test failed:', err);
  process.exit(1);
});
