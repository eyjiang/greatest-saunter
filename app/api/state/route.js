import { NextResponse } from 'next/server';
import { readState, readLocations } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const [state, locations] = await Promise.all([readState(), readLocations()]);
  state.locations = { ...state.locations, ...locations };
  return NextResponse.json(state, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
