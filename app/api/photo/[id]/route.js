import { readPhoto } from '../../../../lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* photo ids are random uuids, so a URL never changes meaning — safe to cache
   hard, which also keeps repeat views off the backend entirely */
export async function GET(_req, { params }) {
  const id = String(params?.id || '');
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) {
    return new Response('bad id', { status: 400 });
  }

  let photo;
  try {
    photo = await readPhoto(id);
  } catch {
    return new Response('photo unavailable', { status: 503 });
  }
  if (!photo) return new Response('not found', { status: 404 });

  return new Response(photo.buffer, {
    headers: {
      'Content-Type': photo.contentType,
      'Content-Length': String(photo.buffer.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      // served from our own origin, so don't let a browser sniff it into
      // something executable
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}
