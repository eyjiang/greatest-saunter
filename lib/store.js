import { del, list, put } from '@vercel/blob';

const KEY = 'state.json';
const ROUTE_KEY = 'route.json';
let cachedUrl = null;

/* blob URLs are stable but store-prefixed, so look one up once and remember it
   — a track is re-read on every location ping and list() is not free */
const urlCache = new Map();

async function blobUrl(pathname) {
  if (urlCache.has(pathname)) return urlCache.get(pathname);
  const { blobs } = await list({ prefix: pathname, limit: 1 });
  const hit = blobs.find((b) => b.pathname === pathname);
  if (!hit) return null;
  urlCache.set(pathname, hit.url);
  return hit.url;
}

async function readJson(pathname) {
  const url = await blobUrl(pathname);
  if (!url) return null;
  const res = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    urlCache.delete(pathname);
    return null;
  }
  return res.json();
}

async function writeJson(pathname, value) {
  const blob = await put(pathname, JSON.stringify(value), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  urlCache.set(pathname, blob.url);
  return blob;
}

async function delPrefix(prefix) {
  const { blobs } = await list({ prefix });
  if (!blobs.length) return;
  await del(blobs.map((b) => b.url));
  for (const b of blobs) urlCache.delete(b.pathname);
}

export function defaultState() {
  return {
    v: 1,
    timer: {
      running: false,
      accumMs: 0,
      lastStartTs: null,
      startedAt: null,
      finished: false,
      finishedAt: null,
      goalHours: 24,
    },
    miles: 0,
    steps: [], // { ts, total } cumulative manual readings
    walkers: [], // { id, name, active, joinedAt, totalMs }
    events: [], // { id, ts, kind, name, text, emoji, photoUrl, lat, lng, amount }
    donations: { goal: 1000, total: 0 },
    challenges: [], // { id, ts, by, text, amount, done, doneTs }
    locations: {}, // name -> { lat, lng, ts }
    config: { donateUrl: '', mapsEmbed: '' },
    // bumped by a full reset so phones discard breadcrumbs from the old walk
    walkEpoch: 0,
  };
}

export async function readState() {
  try {
    if (!cachedUrl) {
      const { blobs } = await list({ prefix: KEY, limit: 1 });
      if (!blobs.length) return defaultState();
      cachedUrl = blobs[0].url;
    }
    const res = await fetch(`${cachedUrl}?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) {
      cachedUrl = null;
      return defaultState();
    }
    const data = await res.json();
    return { ...defaultState(), ...data };
  } catch {
    cachedUrl = null;
    return defaultState();
  }
}

/* live walker locations live in their own blobs so frequent pings
   never race with (or overwrite) the main shared state */
export async function writeLocation(name, loc) {
  await put(`locations/${encodeURIComponent(name)}.json`, JSON.stringify({ name, ...loc }), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

export async function clearLocations(name) {
  await delPrefix(name ? `locations/${encodeURIComponent(name)}.json` : 'locations/');
}

/* ---- planned route (one shared line) ---- */

export async function writeRoute(route) {
  await writeJson(ROUTE_KEY, route);
}

export async function readRoute() {
  try {
    const d = await readJson(ROUTE_KEY);
    return d && Array.isArray(d.points) && d.points.length > 1 ? d : null;
  } catch {
    return null;
  }
}

export async function clearRoute() {
  await delPrefix(ROUTE_KEY);
}

/* ---- walked tracks (breadcrumbs, one blob per walker) ---- */

const trackKey = (name) => `tracks/${encodeURIComponent(name)}.json`;

export async function readTrack(name) {
  try {
    const d = await readJson(trackKey(name));
    return d && Array.isArray(d.points) ? d.points : [];
  } catch {
    return [];
  }
}

export async function writeTrack(name, points) {
  await writeJson(trackKey(name), { name, points, ts: Date.now() });
}

export async function readTracks() {
  try {
    const { blobs } = await list({ prefix: 'tracks/' });
    const out = {};
    await Promise.all(
      blobs.map(async (b) => {
        try {
          const r = await fetch(`${b.url}?ts=${Date.now()}`, { cache: 'no-store' });
          const d = await r.json();
          if (d && d.name && Array.isArray(d.points) && d.points.length > 1) out[d.name] = d.points;
        } catch {}
      })
    );
    return out;
  } catch {
    return {};
  }
}

export async function clearTracks(name) {
  await delPrefix(name ? trackKey(name) : 'tracks/');
}

export async function readLocations() {
  try {
    const { blobs } = await list({ prefix: 'locations/' });
    const out = {};
    await Promise.all(
      blobs.map(async (b) => {
        try {
          const r = await fetch(`${b.url}?ts=${Date.now()}`, { cache: 'no-store' });
          const d = await r.json();
          if (d && d.name && Number.isFinite(d.lat)) out[d.name] = { lat: d.lat, lng: d.lng, ts: d.ts };
        } catch {}
      })
    );
    return out;
  } catch {
    return {};
  }
}

export async function writeState(state) {
  const blob = await put(KEY, JSON.stringify(state), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  cachedUrl = blob.url;
  return state;
}
