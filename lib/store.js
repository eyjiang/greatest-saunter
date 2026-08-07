import { del, list, put } from '@vercel/blob';

/*
  Storage lives behind two drivers.

  Redis (Upstash REST) is used when credentials are present. Vercel Blob is the
  fallback, kept working for local dev and for anyone without a Redis database.

  Blob turned out to be a poor fit for this app: list() and put() are "advanced
  operations" and only 10k/month are free, yet the old code called list() on
  every single /api/state poll. One browser tab open at a 5s poll spends the
  whole monthly allowance in about fourteen hours, and every location ping is
  another put() on top. So this file also caches reads for a few seconds —
  without it, backend traffic scales with the number of people watching.
*/

const KEY = 'state.json';
const ROUTE_KEY = 'route.json';

// Vercel's Upstash integration sets KV_*; a database made directly sets UPSTASH_*
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const REDIS_URL_OK = /^https?:\/\//i.test(REDIS_URL);
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN && REDIS_URL_OK);

const RK = {
  state: 'saunter:state',
  route: 'saunter:route',
  locs: 'saunter:locs', // hash: name -> json
  tracks: 'saunter:tracks', // hash: name -> json
};

const revOf = (s) => Number(s && s.rev) || 0;
const clone = (s) => (s === null || s === undefined ? s : JSON.parse(JSON.stringify(s)));

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
    config: { donateUrl: '', mapsEmbed: '', venmo: '', zelle: '', matchRatio: 0, matchNote: '', charityUrl: '', charityName: '' },
    // bumped by a reset so phones discard breadcrumbs from the old walk
    walkEpoch: 0,
    rev: 0, // write counter; guards against reading back a stale copy
  };
}

/* ---------------- short-lived read cache ----------------
   viewers poll every 5s, so without this the backend sees one read per viewer
   per poll. with it, backend reads are roughly constant no matter how many
   people are watching. */

const CACHE_MS = Number(process.env.READ_CACHE_MS ?? 3000);
const cache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> promise, so concurrent misses share one read

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return clone(hit.value);
  // ten viewers polling at once would otherwise stampede the backend with ten
  // identical reads; they all wait on the first one instead
  const pending = inflight.get(key);
  if (pending) return clone(await pending);
  const p = (async () => {
    try {
      const value = await load();
      cache.set(key, { at: Date.now(), value: clone(value) });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return clone(await p);
}

function prime(key, value) {
  cache.set(key, { at: Date.now(), value: clone(value) });
}

function invalidate(key) {
  cache.delete(key);
}

/* ---------------- redis driver (Upstash REST) ---------------- */

async function redis(...command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`redis ${command[0]} failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data && data.error) throw new Error('redis: ' + data.error);
  return data ? data.result : null;
}

const parse = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};

/* Upstash returns a hash as a flat [field, value, field, value] array */
function hashToObject(flat) {
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      const v = parse(flat[i + 1]);
      if (v) out[flat[i]] = v;
    }
  } else if (flat && typeof flat === 'object') {
    for (const [k, v] of Object.entries(flat)) {
      const parsed = parse(v);
      if (parsed) out[k] = parsed;
    }
  }
  return out;
}

/* ---------------- blob driver ---------------- */

let cachedUrl = null;
const urlCache = new Map();

const MUTABLE = {
  access: 'public',
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: 'application/json',
  cacheControlMaxAge: 0,
};

async function blobUrl(pathname) {
  if (urlCache.has(pathname)) return urlCache.get(pathname);
  const { blobs } = await list({ prefix: pathname, limit: 1 });
  const hit = blobs.find((b) => b.pathname === pathname);
  if (!hit) return null;
  urlCache.set(pathname, hit.url);
  return hit.url;
}

async function blobReadJson(pathname) {
  const url = await blobUrl(pathname);
  if (!url) return null;
  const res = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    urlCache.delete(pathname);
    return null;
  }
  return res.json();
}

async function blobWriteJson(pathname, value) {
  const blob = await put(pathname, JSON.stringify(value), MUTABLE);
  urlCache.set(pathname, blob.url);
  return blob;
}

async function blobDelPrefix(prefix) {
  const { blobs } = await list({ prefix });
  if (!blobs.length) return;
  await del(blobs.map((b) => b.url));
  for (const b of blobs) urlCache.delete(b.pathname);
}

/* ---------------- state ---------------- */

let lastWritten = null; // our own most recent write, to detect a stale read

async function loadState() {
  if (useRedis) {
    const data = parse(await redis('GET', RK.state));
    if (!data) return lastWritten ? clone(lastWritten) : defaultState();
    return { ...defaultState(), ...data };
  }

  if (!cachedUrl) {
    const { blobs } = await list({ prefix: KEY, limit: 1 });
    const hit = blobs.find((b) => b.pathname === KEY);
    if (!hit) return lastWritten ? clone(lastWritten) : defaultState();
    cachedUrl = hit.url;
  }
  let data;
  try {
    const res = await fetch(`${cachedUrl}?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    cachedUrl = null;
    // the record exists but we couldn't read it. returning defaults here would
    // let the caller persist them over the real data, so prefer our own last
    // write and otherwise fail loudly.
    if (lastWritten) return clone(lastWritten);
    throw new Error('could not read saved state: ' + (e.message || e));
  }
  return { ...defaultState(), ...data };
}

export async function readState() {
  const merged = await cached(RK.state, loadState);
  // a backend can serve a copy older than what we just wrote
  return lastWritten && revOf(merged) < revOf(lastWritten) ? clone(lastWritten) : merged;
}

export async function writeState(state) {
  // monotonic across resets too: a handler that rebuilds state from
  // defaultState() starts at rev 0, and the stale-read guard would then
  // mistake the reset for an out-of-date copy and revert it
  state.rev = Math.max(revOf(state), revOf(lastWritten)) + 1;
  if (useRedis) await redis('SET', RK.state, JSON.stringify(state));
  else cachedUrl = (await blobWriteJson(KEY, state)).url;
  lastWritten = clone(state);
  prime(RK.state, state);
  return state;
}

/* ---------------- live walker pins ---------------- */

export async function writeLocation(name, loc) {
  if (useRedis) await redis('HSET', RK.locs, name, JSON.stringify({ name, ...loc }));
  else await put(`locations/${encodeURIComponent(name)}.json`, JSON.stringify({ name, ...loc }), MUTABLE);
  invalidate(RK.locs);
}

export async function clearLocations(name) {
  if (useRedis) {
    if (name) await redis('HDEL', RK.locs, name);
    else await redis('DEL', RK.locs);
  } else {
    await blobDelPrefix(name ? `locations/${encodeURIComponent(name)}.json` : 'locations/');
  }
  invalidate(RK.locs);
}

export async function readLocations() {
  return cached(RK.locs, async () => {
    try {
      if (useRedis) {
        const all = hashToObject(await redis('HGETALL', RK.locs));
        const out = {};
        for (const [n, d] of Object.entries(all)) {
          if (Number.isFinite(d.lat)) out[n] = { lat: d.lat, lng: d.lng, ts: d.ts };
        }
        return out;
      }
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
  });
}

/* ---------------- planned route ---------------- */

export async function writeRoute(route) {
  if (useRedis) await redis('SET', RK.route, JSON.stringify(route));
  else await blobWriteJson(ROUTE_KEY, route);
  prime(RK.route, route);
}

export async function readRoute() {
  return cached(RK.route, async () => {
    try {
      const d = useRedis ? parse(await redis('GET', RK.route)) : await blobReadJson(ROUTE_KEY);
      return d && Array.isArray(d.points) && d.points.length > 1 ? d : null;
    } catch {
      return null;
    }
  });
}

export async function clearRoute() {
  if (useRedis) await redis('DEL', RK.route);
  else await blobDelPrefix(ROUTE_KEY);
  invalidate(RK.route);
}

/* ---------------- walked tracks ---------------- */

const trackKey = (name) => `tracks/${encodeURIComponent(name)}.json`;

export async function readTrack(name) {
  try {
    if (useRedis) {
      const d = parse(await redis('HGET', RK.tracks, name));
      return d && Array.isArray(d.points) ? d.points : [];
    }
    const d = await blobReadJson(trackKey(name));
    return d && Array.isArray(d.points) ? d.points : [];
  } catch {
    return [];
  }
}

export async function writeTrack(name, points) {
  const value = { name, points, ts: Date.now() };
  if (useRedis) await redis('HSET', RK.tracks, name, JSON.stringify(value));
  else await blobWriteJson(trackKey(name), value);
  invalidate(RK.tracks);
}

export async function readTracks() {
  return cached(RK.tracks, async () => {
    try {
      if (useRedis) {
        const all = hashToObject(await redis('HGETALL', RK.tracks));
        const out = {};
        for (const [n, d] of Object.entries(all)) {
          if (Array.isArray(d.points) && d.points.length > 1) out[n] = d.points;
        }
        return out;
      }
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
  });
}

export async function clearTracks(name) {
  if (useRedis) {
    if (name) await redis('HDEL', RK.tracks, name);
    else await redis('DEL', RK.tracks);
  } else {
    await blobDelPrefix(name ? trackKey(name) : 'tracks/');
  }
  invalidate(RK.tracks);
}

/* which backend are we on — surfaced in the admin panel */
export function storageInfo() {
  const seen = [
    process.env.UPSTASH_REDIS_REST_URL ? 'UPSTASH_REDIS_REST_URL' : null,
    process.env.UPSTASH_REDIS_REST_TOKEN ? 'UPSTASH_REDIS_REST_TOKEN' : null,
    process.env.KV_REST_API_URL ? 'KV_REST_API_URL' : null,
    process.env.KV_REST_API_TOKEN ? 'KV_REST_API_TOKEN' : null,
  ].filter(Boolean);

  let hint = null;
  if (useRedis) hint = null;
  else if (!seen.length) hint = 'No Redis env vars found on this deployment. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to the Production environment of THIS Vercel project, then redeploy — env vars only apply to builds made after they are added.';
  else if (!REDIS_URL) hint = 'A Redis token is set but the URL is missing.';
  else if (!REDIS_TOKEN) hint = 'A Redis URL is set but the token is missing.';

  // the REST API needs the https:// endpoint, not the redis:// connection string
  const badUrl = Boolean(REDIS_URL) && !REDIS_URL_OK;
  if (badUrl) hint = 'The Redis URL is not an https:// address. Use the REST URL from Upstash, not the redis:// connection string.';

  return {
    driver: useRedis ? 'redis' : 'blob',
    cacheMs: CACHE_MS,
    redisEnvVarsPresent: seen, // names only, never values
    hint,
  };
}

/* a cheap end-to-end check that the configured backend actually answers */
export async function storageCheck() {
  const info = storageInfo();
  if (info.driver !== 'redis') return { ...info, reachable: null };
  try {
    await redis('SET', 'saunter:healthcheck', String(Date.now()));
    const back = await redis('GET', 'saunter:healthcheck');
    return { ...info, reachable: Boolean(back) };
  } catch (e) {
    return { ...info, reachable: false, error: String(e.message || e) };
  }
}
