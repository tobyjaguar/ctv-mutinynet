# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**BitVault** — a hackathon demo of a Bitcoin vault using `OP_CHECKTEMPLATEVERIFY` (BIP-119). Runs against **Mutinynet** (a public signet with CTV/CSFS soft forks active) and deploys to Vercel. All Bitcoin code is browser-safe; the smoke script and library run on Node.

See `SPEC.md` for the full design doc and current phase status.

## Commands

```bash
npm test                              # vitest run — must stay green
npm run dev                           # next dev
npm run build                         # next build
npm run smoke                         # live end-to-end against Mutinynet
npm run smoke -- --panic              # take the panic path
npm run smoke -- --resume <wif>       # reuse a panic key from a prior run
npm run smoke -- --amount 200000      # custom funding amount in sats
npx tsc --noEmit                      # typecheck
```

## Architecture

| File | Purpose |
|---|---|
| `lib/ctv.ts` | BIP-119 DefaultCheckTemplateVerifyHash. **101/101 reference vectors pass** — keep green. |
| `lib/scripts.ts` | Vault + trigger witness scripts. `OP_CTV = 0xb3` (bitcoinjs-lib has no constant). |
| `lib/vault.ts` | `buildVault({amount, hotAddress, panicPubkey})` derives blueprint deterministically: H2 → trigger script → U → H1 → vault script → V. Network = `bitcoin.networks.testnet` (matches signet `tb1…` HRP). |
| `lib/txs.ts` | `buildUnvaultTx` (witness `[script]`), `buildCompleteTx` (witness `[OP_TRUE, script]`), `buildPanicTx` (BIP-143 sighash, witness `[sig, OP_FALSE, script]`). |
| `lib/esplora.ts` | Mutinynet REST client at `https://mutinynet.com/api`. |
| `lib/mutinyRpc.ts` | RPC facade at `http://3.231.31.216:3000/v1/rpc`. Used only for `testmempoolaccept` preflight. |
| `scripts/smoke.ts` | Standalone CLI for the full V → U → (D \| C) flow. Preflights every broadcast. |
| `lib/__tests__/parseTx.ts` | BigInt-aware tx parser. Required because bitcoinjs-lib's reader rejects the oversized random output amounts in the BIP-119 vectors. |

## Critical constraints

- **Funding amount is part of the CTV commitment.** Vault V expects EXACTLY `params.amountSats`. Funding with anything else means H1's committed output value won't match — Tx1 will be rejected. The smoke script aborts with a clear message on mismatch.
- **`nSequence = delay` on Tx2 (Complete).** Off-by-one breaks CSV.
- **`nSequence = 0xfffffffe` on Tx1 (Unvault) and Tx3 (Panic).** Must match the value committed in H1.
- **Fee is hardcoded** (200 sats/tx, baked into H1 and H2). Don't make it dynamic without rebuilding the blueprint.
- **`nVersion = 2`, `nLockTime = 0`** on all three txs.

## Testing strategy

The CTV math is verified by 101 BIP-119 reference vectors at `lib/__tests__/ctvhash-vectors.json`. **Do not change `lib/ctv.ts` without re-running `npm test`.** A one-byte error means every tx the app builds will be rejected by Mutinynet.

Use `testMempoolAccept(rawHex)` from `lib/mutinyRpc.ts` as a pre-flight before any new tx-broadcast code path. It catches byte errors instantly and avoids burning faucet sats. The smoke script does this for all three txs.

## Next.js 16 caveat

The scaffold is Next.js 16 (App Router), newer than most training data. `AGENTS.md` warns: "This is NOT the Next.js you know — read `node_modules/next/dist/docs/` before writing code." Heed it before adding routes/middleware/config.

## Mutinynet quick reference

| What | URL |
|---|---|
| Explorer | `https://mutinynet.com/tx/{txid}` |
| Esplora API | `https://mutinynet.com/api` |
| Faucet | `https://faucet.mutinynet.com/` |
| RPC facade (preflight only) | `http://3.231.31.216:3000` (`/openapi.json` lists routes) |

Block time ≈ 30s, so the default 3-block CSV ≈ 1.5 minutes — tuned for a punchy live demo.

