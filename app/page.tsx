'use client';

import { Buffer } from 'buffer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  buildVault,
  generateKeyPair,
  keyPairFromWIF,
  p2wpkhAddress,
  DELAY_BLOCKS,
  DEFAULT_FEE_SATS,
} from '@/lib/vault';
import {
  buildUnvaultTx,
  buildCompleteTx,
  buildPanicTx,
} from '@/lib/txs';
import {
  broadcastTx,
  explorerAddressUrl,
  explorerTxUrl,
  getTipHeight,
  getUtxos,
  MUTINYNET_FAUCET,
} from '@/lib/esplora';

if (typeof window !== 'undefined') {
  const w = window as unknown as { Buffer?: typeof Buffer };
  if (!w.Buffer) w.Buffer = Buffer;
}

const STORAGE_KEY = 'bitvault:state:v1';
const POLL_MS = 5000;
const DEFAULT_AMOUNT_SATS = '100000';

interface PersistedState {
  amountSats: string;
  hotAddress: string;
  panicWif: string;
  coldAddress: string;
  vaultAddress: string;
  triggerAddress: string;
  /** CSV delay baked into this vault's on-chain script. May be undefined for vaults created before this field existed — treat as 10 (the prior default). */
  delay?: number;
  fundingTxid?: string;
  fundingVout?: number;
  fundingValue?: string;
  unvaultTxid?: string;
  triggerConfirmedHeight?: number;
  finalTxid?: string;
  finalKind?: 'complete' | 'panic';
}

const LEGACY_DELAY = 10;

function loadState(): PersistedState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

function saveState(s: PersistedState | null) {
  if (typeof window === 'undefined') return;
  if (s) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  else window.localStorage.removeItem(STORAGE_KEY);
}

type PreflightOutcome =
  | { kind: 'allowed' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; error: string };

async function preflight(rawHex: string): Promise<PreflightOutcome> {
  const res = await fetch('/api/preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawHex }),
  });
  const data = (await res.json().catch(() => ({}))) as
    | { kind: 'result'; result: { allowed: boolean; ['reject-reason']?: string } }
    | { kind: 'unavailable'; error: string }
    | { kind: 'error'; error: string };
  if (!res.ok || data.kind === 'error') {
    throw new Error(('error' in data && data.error) || `preflight HTTP ${res.status}`);
  }
  if (data.kind === 'unavailable') {
    return { kind: 'unavailable', error: data.error };
  }
  if (data.result.allowed) return { kind: 'allowed' };
  return { kind: 'rejected', reason: data.result['reject-reason'] ?? 'unknown' };
}

export default function Home() {
  const [state, setStateRaw] = useState<PersistedState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [tip, setTip] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setStateRaw(loadState());
    setHydrated(true);
  }, []);

  const setState = useCallback(
    (updater: (prev: PersistedState | null) => PersistedState | null) => {
      setStateRaw((prev) => {
        const next = updater(prev);
        saveState(next);
        return next;
      });
    },
    [],
  );

  const vaultDelay = state?.delay ?? LEGACY_DELAY;

  const targetHeight = useMemo(() => {
    if (!state?.triggerConfirmedHeight) return null;
    return state.triggerConfirmedHeight + vaultDelay;
  }, [state?.triggerConfirmedHeight, vaultDelay]);

  const blocksRemaining = useMemo(() => {
    if (targetHeight === null || tip === null) return null;
    return Math.max(0, targetHeight - tip);
  }, [targetHeight, tip]);

  // Poll for funding UTXO at the vault address (exact-amount match).
  useEffect(() => {
    if (!state?.vaultAddress || state.fundingTxid) return;
    const target = BigInt(state.amountSats);
    const vault = state.vaultAddress;
    let cancelled = false;
    const tick = async () => {
      try {
        const utxos = await getUtxos(vault);
        const match = utxos.find((u) => BigInt(u.value) === target);
        if (match && !cancelled) {
          setState((prev) =>
            prev
              ? { ...prev, fundingTxid: match.txid, fundingVout: match.vout, fundingValue: match.value.toString() }
              : prev,
          );
        }
      } catch {
        /* keep polling */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [state?.vaultAddress, state?.fundingTxid, state?.amountSats, setState]);

  // Poll for unvault confirmation at the trigger address.
  useEffect(() => {
    if (!state?.unvaultTxid || state.triggerConfirmedHeight) return;
    const trigger = state.triggerAddress;
    const txid = state.unvaultTxid;
    let cancelled = false;
    const tick = async () => {
      try {
        const utxos = await getUtxos(trigger);
        const match = utxos.find((u) => u.txid === txid);
        const h = match?.status.block_height;
        if (match?.status.confirmed && typeof h === 'number' && !cancelled) {
          setState((prev) => (prev ? { ...prev, triggerConfirmedHeight: h } : prev));
        }
      } catch {
        /* keep polling */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [state?.unvaultTxid, state?.triggerConfirmedHeight, state?.triggerAddress, setState]);

  // Poll tip height while waiting for CSV.
  useEffect(() => {
    if (!state?.triggerConfirmedHeight || state.finalTxid) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const t = await getTipHeight();
        if (!cancelled) setTip(t);
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [state?.triggerConfirmedHeight, state?.finalTxid]);

  const handleConfigure = useCallback(
    (amountSats: bigint, hotAddress: string) => {
      setError(null);
      const panic = generateKeyPair();
      const cold = p2wpkhAddress(generateKeyPair().pubkey);
      const bp = buildVault({
        amountSats,
        hotAddress,
        panicPubkey: panic.pubkey,
        delay: DELAY_BLOCKS,
      });
      setState(() => ({
        amountSats: amountSats.toString(),
        hotAddress,
        panicWif: panic.wif,
        coldAddress: cold,
        vaultAddress: bp.vaultAddress,
        triggerAddress: bp.triggerAddress,
        delay: bp.params.delay,
      }));
    },
    [setState],
  );

  const rebuildBlueprint = useCallback((s: PersistedState) => {
    const panicKey = keyPairFromWIF(s.panicWif);
    return buildVault({
      amountSats: BigInt(s.amountSats),
      hotAddress: s.hotAddress,
      panicPubkey: Buffer.from(panicKey.publicKey),
      delay: s.delay ?? LEGACY_DELAY,
    });
  }, []);

  const runPreflight = useCallback(
    async (label: string, hex: string, setBusyMsg: (m: string) => void) => {
      const outcome = await preflight(hex);
      if (outcome.kind === 'rejected') {
        throw new Error(`Mempool rejected ${label}: ${outcome.reason}`);
      }
      if (outcome.kind === 'unavailable') {
        console.warn(`preflight unavailable for ${label} (${outcome.error}); broadcasting anyway`);
        setBusyMsg(`Preflight unavailable, broadcasting ${label}…`);
      }
    },
    [],
  );

  const handleUnvault = useCallback(async () => {
    if (!state?.fundingTxid || state.fundingVout === undefined) return;
    setError(null);
    setBusy('Broadcasting unvault…');
    try {
      const bp = rebuildBlueprint(state);
      const tx = buildUnvaultTx(bp, { txid: state.fundingTxid, vout: state.fundingVout });
      const hex = tx.toHex();
      await runPreflight('unvault', hex, setBusy);
      const txid = await broadcastTx(hex);
      setState((prev) => (prev ? { ...prev, unvaultTxid: txid } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [state, rebuildBlueprint, setState, runPreflight]);

  const handleComplete = useCallback(async () => {
    if (!state?.unvaultTxid) return;
    setError(null);
    setBusy('Broadcasting complete…');
    try {
      const bp = rebuildBlueprint(state);
      const tx = buildCompleteTx(bp, { txid: state.unvaultTxid, vout: 0 });
      const hex = tx.toHex();
      await runPreflight('complete', hex, setBusy);
      const txid = await broadcastTx(hex);
      setState((prev) => (prev ? { ...prev, finalTxid: txid, finalKind: 'complete' } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [state, rebuildBlueprint, setState, runPreflight]);

  const handlePanic = useCallback(async () => {
    if (!state?.unvaultTxid) return;
    setError(null);
    setBusy('Broadcasting panic…');
    try {
      const bp = rebuildBlueprint(state);
      const panicKey = keyPairFromWIF(state.panicWif);
      const triggerValue = bp.unvaultedAmount;
      const tx = buildPanicTx(bp, {
        triggerUtxo: { txid: state.unvaultTxid, vout: 0 },
        triggerValueSats: triggerValue,
        coldAddress: state.coldAddress,
        panicKey,
      });
      const hex = tx.toHex();
      await runPreflight('panic', hex, setBusy);
      const txid = await broadcastTx(hex);
      setState((prev) => (prev ? { ...prev, finalTxid: txid, finalKind: 'panic' } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [state, rebuildBlueprint, setState, runPreflight]);

  const reset = useCallback(() => {
    if (typeof window !== 'undefined' && !window.confirm('Reset vault state? This cannot be undone.')) {
      return;
    }
    setState(() => null);
    setTip(null);
    setError(null);
    setBusy(null);
  }, [setState]);

  if (!hydrated) {
    return <main className="min-h-screen p-8" />;
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-4 sm:p-8">
      <div className="mx-auto max-w-2xl flex flex-col gap-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">BitVault</h1>
            <p className="text-sm text-zinc-500">
              CTV vault on Mutinynet · CSV delay: {vaultDelay} blocks (~{Math.max(1, Math.round((vaultDelay * 30) / 60))} min)
            </p>
          </div>
          {state && (
            <button
              type="button"
              onClick={reset}
              className="text-xs text-zinc-500 hover:text-red-600 underline underline-offset-4"
            >
              reset
            </button>
          )}
        </header>

        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950 p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        {busy && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 p-3 text-sm text-amber-800 dark:text-amber-200">
            {busy}
          </div>
        )}

        {!state ? (
          <ConfigureCard onSubmit={handleConfigure} setError={setError} />
        ) : (
          <>
            <SetupSummary state={state} />
            <FundCard state={state} />
            {state.fundingTxid && (
              <UnvaultCard state={state} onUnvault={handleUnvault} busy={!!busy} />
            )}
            {state.unvaultTxid && (
              <ResolveCard
                state={state}
                tip={tip}
                blocksRemaining={blocksRemaining}
                targetHeight={targetHeight}
                onComplete={handleComplete}
                onPanic={handlePanic}
                busy={!!busy}
              />
            )}
          </>
        )}

        <footer className="pt-6 text-center text-xs text-zinc-500">
          Funds locked: BIP-119 OP_CHECKTEMPLATEVERIFY · Mutinynet signet · not real money
        </footer>
      </div>
    </main>
  );
}

function ConfigureCard({
  onSubmit,
  setError,
}: {
  onSubmit: (amountSats: bigint, hotAddress: string) => void;
  setError: (e: string | null) => void;
}) {
  const [amount, setAmount] = useState<string>(DEFAULT_AMOUNT_SATS);
  const [hot, setHot] = useState<string>('');

  const generateHot = () => {
    setHot(p2wpkhAddress(generateKeyPair().pubkey));
  };

  const submit = () => {
    setError(null);
    try {
      const sats = BigInt(amount);
      if (sats <= DEFAULT_FEE_SATS * 2n) {
        throw new Error(`amount must exceed ${DEFAULT_FEE_SATS * 2n} sats (2× fee)`);
      }
      if (!hot) throw new Error('hot address is required (use Generate to create one)');
      onSubmit(sats, hot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card title="1 · Configure" subtitle="Choose vault amount and where the funds release after the timelock.">
      <Field label="Amount (sats)">
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-zinc-500">
          You must fund the vault with EXACTLY this amount or CTV rejects the spend.
        </p>
      </Field>
      <Field label="Hot address (release destination)">
        <div className="flex gap-2">
          <input
            type="text"
            value={hot}
            onChange={(e) => setHot(e.target.value)}
            placeholder="tb1…"
            className={inputClass}
          />
          <button type="button" onClick={generateHot} className={btnSecondary}>
            Generate
          </button>
        </div>
      </Field>
      <button type="button" onClick={submit} className={btnPrimary}>
        Build vault
      </button>
    </Card>
  );
}

function SetupSummary({ state }: { state: PersistedState }) {
  const [showPanic, setShowPanic] = useState(false);
  return (
    <Card title="1 · Configured" subtitle="Vault blueprint derived. Save the panic key — you'll need it if anything goes wrong.">
      <KV label="Amount" value={`${state.amountSats} sats`} />
      <KV label="Hot address" value={state.hotAddress} mono />
      <KV label="Cold address (panic dest)" value={state.coldAddress} mono />
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Panic key (WIF)</span>
          <button
            type="button"
            onClick={() => setShowPanic((v) => !v)}
            className="text-xs text-blue-600 hover:underline"
          >
            {showPanic ? 'hide' : 'reveal'}
          </button>
        </div>
        {showPanic ? (
          <code className="block break-all rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-xs">{state.panicWif}</code>
        ) : (
          <code className="block rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-xs text-zinc-400">••••••••••••••</code>
        )}
        <p className="text-xs text-zinc-500">
          Stored in this browser&rsquo;s localStorage. If you close this tab, you can resume by reopening this page.
        </p>
      </div>
    </Card>
  );
}

function FundCard({ state }: { state: PersistedState }) {
  const funded = !!state.fundingTxid;
  return (
    <Card
      title="2 · Fund vault"
      subtitle={
        funded
          ? 'Vault is funded. Ready to unvault.'
          : `Send EXACTLY ${state.amountSats} sats to the vault address.`
      }
      tone={funded ? 'done' : 'active'}
    >
      <KV label="Vault address (V)" value={state.vaultAddress} mono link={explorerAddressUrl(state.vaultAddress)} />
      {!funded && (
        <>
          <div className="flex justify-center bg-white p-3 rounded-md w-fit mx-auto">
            <QRCodeSVG value={state.vaultAddress} size={180} level="M" />
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={state.vaultAddress} label="Copy address" />
            <CopyButton value={state.amountSats} label={`Copy amount (${state.amountSats} sats)`} />
            <a href={MUTINYNET_FAUCET} target="_blank" rel="noopener noreferrer" className={btnSecondary}>
              Open faucet ↗
            </a>
          </div>
          <p className="text-xs text-zinc-500">Polling every {POLL_MS / 1000}s for a UTXO matching the exact amount…</p>
        </>
      )}
      {funded && state.fundingTxid && (
        <KV label="Funding txid" value={state.fundingTxid} mono link={explorerTxUrl(state.fundingTxid)} />
      )}
    </Card>
  );
}

function UnvaultCard({
  state,
  onUnvault,
  busy,
}: {
  state: PersistedState;
  onUnvault: () => void;
  busy: boolean;
}) {
  const done = !!state.unvaultTxid;
  return (
    <Card
      title="3 · Unvault (V → U)"
      subtitle={
        done
          ? state.triggerConfirmedHeight
            ? `Unvault confirmed in block ${state.triggerConfirmedHeight}.`
            : 'Unvault broadcast. Waiting for confirmation…'
          : 'Move funds from V into the trigger address U. Starts the CSV countdown.'
      }
      tone={done ? 'done' : 'active'}
    >
      <KV label="Trigger address (U)" value={state.triggerAddress} mono link={explorerAddressUrl(state.triggerAddress)} />
      {!done && (
        <button type="button" onClick={onUnvault} disabled={busy} className={btnPrimary}>
          Unvault
        </button>
      )}
      {state.unvaultTxid && (
        <KV label="Unvault txid" value={state.unvaultTxid} mono link={explorerTxUrl(state.unvaultTxid)} />
      )}
    </Card>
  );
}

function ResolveCard({
  state,
  tip,
  blocksRemaining,
  targetHeight,
  onComplete,
  onPanic,
  busy,
}: {
  state: PersistedState;
  tip: number | null;
  blocksRemaining: number | null;
  targetHeight: number | null;
  onComplete: () => void;
  onPanic: () => void;
  busy: boolean;
}) {
  const csvReady = blocksRemaining !== null && blocksRemaining === 0;
  const done = !!state.finalTxid;

  return (
    <Card
      title="4 · Resolve"
      subtitle={
        done
          ? state.finalKind === 'panic'
            ? `Funds swept to cold address via panic path.`
            : `Funds released to hot address.`
          : csvReady
            ? 'CSV elapsed. You can complete (release to hot) or panic (sweep to cold).'
            : 'Waiting for CSV delay. Panic is available at any time.'
      }
      tone={done ? 'done' : 'active'}
    >
      {!done && state.triggerConfirmedHeight && (
        <div className="rounded bg-zinc-100 dark:bg-zinc-900 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-500">Confirmed at</span>
            <span className="font-mono">{state.triggerConfirmedHeight}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Tip</span>
            <span className="font-mono">{tip ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500">Unlocks at</span>
            <span className="font-mono">{targetHeight ?? '—'}</span>
          </div>
          <div className="flex justify-between font-semibold pt-1 border-t border-zinc-200 dark:border-zinc-800 mt-1">
            <span>Blocks remaining</span>
            <span className="font-mono">{blocksRemaining ?? '—'}</span>
          </div>
        </div>
      )}

      {!done && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onComplete}
            disabled={busy || !csvReady}
            className={btnPrimary}
            title={csvReady ? 'Release to hot address' : 'CSV not yet elapsed'}
          >
            Complete (release to hot)
          </button>
          <button type="button" onClick={onPanic} disabled={busy} className={btnDanger}>
            Panic (sweep to cold)
          </button>
        </div>
      )}

      {state.finalTxid && (
        <KV
          label={state.finalKind === 'panic' ? 'Panic txid' : 'Complete txid'}
          value={state.finalTxid}
          mono
          link={explorerTxUrl(state.finalTxid)}
        />
      )}
    </Card>
  );
}

function Card({
  title,
  subtitle,
  children,
  tone = 'active',
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  tone?: 'active' | 'done';
}) {
  const border =
    tone === 'done'
      ? 'border-green-300 dark:border-green-900'
      : 'border-zinc-200 dark:border-zinc-800';
  return (
    <section className={`rounded-xl border ${border} bg-white dark:bg-zinc-900 p-4 sm:p-5 flex flex-col gap-3`}>
      <div>
        <h2 className="font-semibold">{title}</h2>
        {subtitle && <p className="text-sm text-zinc-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function KV({
  label,
  value,
  mono = false,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className={`break-all rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-xs hover:underline ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </a>
      ) : (
        <code className={`block break-all rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-xs ${mono ? 'font-mono' : ''}`}>
          {value}
        </code>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onClick = () => {
    if (typeof navigator === 'undefined') return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button type="button" onClick={onClick} className={btnSecondary}>
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

const inputClass =
  'w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500';

const btnPrimary =
  'inline-flex items-center justify-center rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors';

const btnSecondary =
  'inline-flex items-center justify-center rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-sm font-medium px-3 py-2 transition-colors';

const btnDanger =
  'inline-flex items-center justify-center rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors';
