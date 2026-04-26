import { testMempoolAccept } from '@/lib/mutinyRpc';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  let body: { rawHex?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.rawHex !== 'string' || body.rawHex.length === 0) {
    return Response.json({ error: 'rawHex (string) required' }, { status: 400 });
  }
  try {
    const result = await testMempoolAccept(body.rawHex);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
