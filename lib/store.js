import { del, list, put } from '@vercel/blob';

const KEY = 'state.json';
let cachedUrl = null;

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
  const prefix = name ? `locations/${encodeURIComponent(name)}.json` : 'locations/';
  const { blobs } = await list({ prefix });
  if (blobs.length) await del(blobs.map((b) => b.url));
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
