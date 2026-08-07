import { NextResponse } from 'next/server';
import { readState, readLocations, storageInfo } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const [state, locations] = await Promise.all([readState(), readLocations()]);
    state.locations = { ...state.locations, ...locations };
    return NextResponse.json(state, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (e) {
    // readState now throws rather than handing back defaults it might overwrite
    // with; the client keeps whatever it already has on a non-ok response
    const info = storageInfo();
    return NextResponse.json({
      error: 'state read failed: ' + (e.message || e),
      driver: info.driver,
      hint: info.hint,
    }, { status: 503 });
  }
}
