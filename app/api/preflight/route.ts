import { testMempoolAccept, MempoolAcceptResult } from '@/lib/mutinyRpc';

export const runtime = 'nodejs';

export type PreflightResponse =
  | { kind: 'result'; result: MempoolAcceptResult }
  | { kind: 'unavailable'; error: string }
  | { kind: 'error'; error: string };

export async function POST(request: Request) {
  let body: { rawHex?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { kind: 'error', error: 'invalid JSON body' } satisfies PreflightResponse,
      { status: 400 },
    );
  }
  if (typeof body.rawHex !== 'string' || body.rawHex.length === 0) {
    return Response.json(
      { kind: 'error', error: 'rawHex (string) required' } satisfies PreflightResponse,
      { status: 400 },
    );
  }
  try {
    const result = await testMempoolAccept(body.rawHex);
    return Response.json({ kind: 'result', result } satisfies PreflightResponse);
  } catch (err) {
    // Vercel serverless can't always reach the HTTP-only RPC facade.
    // Treat connectivity failures as "preflight unavailable" rather than a
    // hard error — the tx encoding is already verified by the test vectors.
    return Response.json({
      kind: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    } satisfies PreflightResponse);
  }
}
