import { NextResponse } from 'next/server';
import { readRoute, readTracks } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* map geometry lives here rather than in /api/state: a full day's track is
   thousands of points and /api/state is polled every 5s by every viewer */
export async function GET() {
  const [route, tracks] = await Promise.all([readRoute(), readTracks()]);
  return NextResponse.json({ route, tracks }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
