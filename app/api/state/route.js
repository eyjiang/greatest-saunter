import { NextResponse } from 'next/server';
import { readState } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const state = await readState();
  return NextResponse.json(state, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
