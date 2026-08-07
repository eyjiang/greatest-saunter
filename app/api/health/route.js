import { NextResponse } from 'next/server';
import { storageCheck } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* which storage driver this deployment actually picked, and whether it answers.
   reports env var NAMES only — never their values. */
export async function GET() {
  const info = await storageCheck();
  return NextResponse.json(info, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
