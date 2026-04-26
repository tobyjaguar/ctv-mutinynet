# BitVault — Project Spec

A minimal Bitcoin vault demo on Mutinynet using **OP_CHECKTEMPLATEVERIFY (CTV / BIP-119)**. Hackathon target: ~24–48h, deployed to **Vercel**.

---

## Status (resume here)

| Phase | State | Notes |
|---|---|---|
| 1. CTV primitives | ✅ done | `lib/ctv.ts`, `lib/scripts.ts`, `lib/esplora.ts`. **101/101 BIP-119 reference vectors pass.** |
| 2. Tx construction + smoke | ✅ done | `lib/txs.ts`, `lib/vault.ts`, `lib/mutinyRpc.ts`, `scripts/smoke.ts`. **Validated end-to-end against live Mutinynet.** |
| 3. Web UI | ⏳ next | `app/page.tsx` single-page state machine. See "Phase 3 plan" below. |
| 4. Polish | pending | Loading states, retries, copy buttons, judge explainer, Vercel deploy verification. |
| 5. Stretch | pending | Multi-vault list, Taproot version, panic webhook, CSFS oracle. |

### Phase 1+2 live verification (proof it works)

The smoke script ran V → U → D successfully against Mutinynet:

| Step | Tx |
|---|---|
| Fund (faucet → V) | https://mutinynet.com/tx/22783db70aa084b18c1f4af9b705f8e9e1b9433b4480480a9a8f3a0013fa1954 |
| Unvault Tx1 (V → U, vsize 104, no sig) | https://mutinynet.com/tx/0bc0ab67ac8c78cbaeac94365a5188314e88ca2b6e90267e1be9370a8290ebb0 |
| Complete Tx2 (U → D, vsize 103, no sig) | https://mutinynet.com/tx/99fa0e81b6e699b8c662c0f9e089e4b2e0d911b063120943579640f392a6f582 |

Both H1 and H2 byte-perfect — Bitcoin Core accepted them through `testmempoolaccept` and broadcast.

---

## Phase 3 plan (UI)

Build client-side only (per the design recommendation). All bitcoinjs-lib + Esplora calls run in the browser; no API routes needed; deploys as a static SPA.

### Files to create

```
app/
  page.tsx                    # single-page state machine (use existing lib/* directly)
  components/
    VaultStepper.tsx          # horizontal stepper: Empty → Created → Funded → Unvaulting → Counting → Done
    AddressCard.tsx           # address display + copy + explorer link
    Countdown.tsx             # mm:ss + remaining_blocks based on tip polling
    ExplainerPanel.tsx        # "What is CTV?" 3-bullet TL;DR for judges
lib/
  storage.ts                  # localStorage persistence keyed by vault address
```

### State machine (frontend)

```
[Empty]      → user clicks "Create Vault" → generate panic key + ephemeral hot/cold + buildVault(...)
[Created]    → display V address, faucet link, copy button. Poll /address/V/utxo every 5s.
[Funded]     → enable "Unvault" button. (Validate funding amount matches blueprint.)
[Unvaulting] → buildUnvaultTx → testMempoolAccept (optional in browser, may be CORS-blocked) → broadcast → poll for confirmation at U.
[Counting]   → live countdown: blocks_remaining = (funding_block + delay) - tip.
              Buttons: Complete (disabled until ready) and Panic (always armed).
[Done — Hot] → Complete tx broadcast, funds at D. Show explorer link.
[Done — Cold]→ Panic tx broadcast, funds at C. Show explorer link.
```

Persist `{blueprint, panicWif, fundingTxid, state}` to `localStorage` keyed by vault address so a refresh survives.

### CORS note

The Mutiny RPC facade is HTTP (not HTTPS) — browsers will block mixed-content `fetch` from a Vercel HTTPS page. So `testMempoolAccept` is **smoke-only**, not used in the UI. Esplora at `mutinynet.com/api` is HTTPS and CORS-enabled — fine for the browser.

### Key handling

Generate panic key with `ECPair.makeRandom()` in the browser. Store WIF in `localStorage` only. Display a **prominent banner**: "Demo on testnet. Keys are stored in your browser. Do not use this for mainnet funds."

For an extra-clean demo, let the user paste in their own hot/cold addresses (e.g. from Mutiny Wallet's signet mode) instead of generating ephemeral ones.

---

## Tech stack (locked in)

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) — the scaffold landed on 16, not 14 as the original spec assumed |
| Language | TypeScript |
| Bitcoin | `bitcoinjs-lib` v6 + `@bitcoinerlab/secp256k1` + `ecpair` |
| Network | Esplora REST at `mutinynet.com/api`; RPC facade at `3.231.31.216:3000/v1/rpc` for preflight |
| State | `localStorage` (no DB) |
| Styling | Tailwind v4 (already wired by `create-next-app`) |
| Testing | Vitest |
| CLI runner | `tsx` (for `scripts/smoke.ts`) |
| Deploy | Vercel |

---

## The Bitcoin protocol design

Two scripts, two P2WSH addresses:

1. **Vault `V`** — initial deposit. Script: `<H1> OP_CTV`. Anyone can spend, but only into the exact tx H1 commits to.
2. **Trigger `U`** — intermediate, post-unvault.
   ```
   OP_IF
       <delay> OP_CSV OP_DROP <H2> OP_CTV
   OP_ELSE
       <panic_pubkey> OP_CHECKSIG
   OP_ENDIF
   ```

Plus two regular P2WPKH addresses: hot `D` (eventual destination) and cold `C` (panic sweep target).

### The three transactions

| Tx | Spends | Witness | Sig? |
|---|---|---|---|
| **Unvault** Tx1 | V → U | `[<vault_witness_script>]` | None (CTV) |
| **Complete** Tx2 | U → D | `[OP_TRUE, <trigger_witness_script>]` | None (CTV + CSV) |
| **Panic** Tx3 | U → C | `[<sig>, OP_FALSE, <trigger_witness_script>]` | Panic key |

Tx2 **must** have `nSequence = delay` (= 3, by default) on the input or CSV fails.

### BIP-119 hash (the hardest bit, already done)

`computeCtvHash(version, locktime, sequences, outputs, inputIndex)` in `lib/ctv.ts`. Verified against all 101 official vectors. Don't touch without re-running `npm test`.

For SegWit-only design (this app), `scriptSigsHash` is omitted — all our scriptSigs are empty. The full form (`computeCtvHashFull`) supports the optional field for vector compatibility.

### Address construction

```ts
import * as bitcoin from 'bitcoinjs-lib';
const network = bitcoin.networks.testnet; // signet uses testnet bech32 HRP
```

`OP_CTV` is `0xb3` (= `OP_NOP4`). bitcoinjs-lib has no constant — push it as a raw byte.

---

## Design constants (don't change without rebuilding the blueprint)

| Const | Value | File |
|---|---|---|
| `DELAY_BLOCKS` | `3` | `lib/vault.ts` |
| `DEFAULT_FEE_SATS` | `200n` | `lib/vault.ts` |
| `UNVAULT_SEQUENCE` | `0xfffffffe` | `lib/vault.ts` |
| `TX_VERSION` | `2` | `lib/vault.ts` |

---

## Demo script (5 min for judges)

> **0:00** — "Bitcoin doesn't have smart contracts the way Ethereum does. But on Mutinynet — a Bitcoin signet with proposed soft forks turned on — there's an opcode called `OP_CHECKTEMPLATEVERIFY` that lets a UTXO commit to exactly one future transaction. Today I'm using it to build a vault."
>
> **0:30** — *Click "Create Vault."* "I just generated a vault address. The script is two opcodes: a hash, and `OP_CTV`. That's the entire smart contract."
>
> **1:00** — *Open faucet, send 100k sats.* "Funding now. Mutinynet has 30-second blocks…" *Wait for confirmation.* "…confirmed."
>
> **1:30** — *Click "Unvault."* "I just broadcast a transaction that no one signed. CTV enforced where the money had to go: an intermediate address with a 3-block timelock. Watch the counter."
>
> **2:00** — *Counter ticks.* "Imagine an attacker just compromised my hot wallet and triggered this withdrawal. I have ~90 seconds to react."
>
> **3:00** — *Click "Panic."* "Funds in my cold address. Attacker got nothing. No multisig coordination, no on-chain governance, no executor contract — just a UTXO that knew the rules."
>
> **4:00** — "Now the alternate ending…" *Reset, fund, unvault, let timer expire, click "Complete."* "And there it is — funds released to the hot address. Same UTXO, two possible futures, both enforced at consensus."
>
> **4:45** — "Built on Mutinynet, deployed on Vercel, ~600 lines of TypeScript. That's BitVault."

---

## References

- **BIP-119**: https://github.com/bitcoin/bips/blob/master/bip-0119.mediawiki
- **Mutinynet**: https://mutinynet.com (explorer), https://mutinynet.com/api (Esplora), https://faucet.mutinynet.com (faucet)
- **Mutiny RPC OpenAPI**: http://3.231.31.216:3000/openapi.json
- **bitcoinjs-lib examples**: https://github.com/bitcoinjs/bitcoinjs-lib/tree/master/test/integration

---

## TL;DR for next session

> Phase 1+2 done and live-verified on Mutinynet. The CTV/CSV math is correct (101/101 vectors + 3 live txs). All `lib/*.ts` is browser-safe and ready to consume from a React component. The remaining work is purely UI: build `app/page.tsx` as a state machine on top of `buildVault`, `buildUnvaultTx`, `buildCompleteTx`, `buildPanicTx`, plus polling `getTipHeight`/`getUtxos`. Persist to localStorage. Deploy to Vercel — no env vars, no API routes needed.
