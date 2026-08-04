import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 4.4 * 1024 * 1024;

export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'no file' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'file too large (max ~4MB)' }, { status: 413 });
    }
    const safeName = (file.name || 'photo.jpg').replace(/[^\w.-]/g, '_').slice(-60);
    const blob = await put(`photos/${Date.now()}-${safeName}`, file, { access: 'public' });
    return NextResponse.json({ url: blob.url });
  } catch (e) {
    return NextResponse.json({ error: 'upload failed' }, { status: 500 });
  }
}
