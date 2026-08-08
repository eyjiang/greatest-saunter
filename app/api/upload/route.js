import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { writePhoto } from '../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 4.4 * 1024 * 1024; // Vercel's request body ceiling

/* Only raster formats we're happy to serve from our own origin. SVG is
   deliberately excluded — it can carry script, and unlike the old Blob URLs
   these are served from the site's own domain. */
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'no file was attached' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'that photo is too big (max ~4MB)' }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!buffer.length) {
      return NextResponse.json({ error: 'that file was empty' }, { status: 400 });
    }

    const contentType = String(file.type || '').toLowerCase() || 'image/jpeg';
    if (!ALLOWED.has(contentType)) {
      return NextResponse.json(
        { error: `unsupported image type "${contentType}" — use JPEG, PNG, WEBP or GIF` },
        { status: 415 }
      );
    }

    const url = await writePhoto(randomUUID(), contentType, buffer);
    return NextResponse.json({ url });
  } catch (e) {
    // the old version swallowed this into a bare "upload failed", which made a
    // storage outage indistinguishable from a bad file
    return NextResponse.json({ error: 'upload failed: ' + (e.message || e) }, { status: 500 });
  }
}
