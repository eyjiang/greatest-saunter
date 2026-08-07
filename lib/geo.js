/* geometry helpers shared by the map UI and the API routes.
   points are [lat, lng] or [lat, lng, ts] tuples — compact on purpose,
   since a 24-hour track is thousands of them. */

const M_PER_DEG_LAT = 111320;

const toRad = (d) => (d * Math.PI) / 180;
const round5 = (n) => Math.round(n * 1e5) / 1e5; // ~1m, plenty for a walk

export function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthMeters(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += haversineMeters(points[i - 1], points[i]);
  return m;
}

export function metersToMiles(m) {
  return m / 1609.344;
}

/* perpendicular distance in metres, via a local equirectangular projection —
   accurate enough at the scale of a single walk */
function perpDist(p, a, b) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(toRad(a[0]));
  const px = (p[1] - a[1]) * mPerDegLng;
  const py = (p[0] - a[0]) * M_PER_DEG_LAT;
  const bx = (b[1] - a[1]) * mPerDegLng;
  const by = (b[0] - a[0]) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

/* Douglas–Peucker, iterative so a long track can't blow the stack */
export function simplify(points, toleranceM) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(points[i], points[s], points[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranceM && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/* simplify just enough to fit under maxPoints */
export function capPoints(points, maxPoints) {
  let out = points;
  let tol = 2;
  while (out.length > maxPoints && tol <= 1024) {
    out = simplify(points, tol);
    tol *= 2;
  }
  return out;
}

/* drop points that barely moved, but never drop one after a long gap
   (standing still for 20 minutes is worth a point) */
export function thinTrack(points, minMeters = 8, maxGapMs = 120000) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last) { out.push(p); continue; }
    const moved = haversineMeters(last, p) >= minMeters;
    const stale = Number.isFinite(p[2]) && Number.isFinite(last[2]) && p[2] - last[2] >= maxGapMs;
    if (moved || stale) out.push(p);
  }
  const last = points[points.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last); // keep the trail head
  return out;
}

export function sanitizePoints(raw, max = 20000) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw.slice(0, max)) {
    if (!Array.isArray(p)) continue;
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const ts = Number(p[2]);
    out.push(Number.isFinite(ts) && ts > 0 ? [round5(lat), round5(lng), Math.round(ts)] : [round5(lat), round5(lng)]);
  }
  return out;
}

/* union of what we already stored and what the phone just sent.
   the phone re-sends a tail of recent points every ping, so a stale
   read can't permanently lose a chunk of the walk. */
export function mergeTrack(existing, incoming, { maxPoints = 1500, minMeters = 8 } = {}) {
  const byTs = new Map();
  for (const p of [...existing, ...incoming]) {
    if (!Number.isFinite(p[2])) continue;
    byTs.set(p[2], p);
  }
  let pts = [...byTs.values()].sort((a, b) => a[2] - b[2]);
  pts = thinTrack(pts, minMeters);
  return pts.length > maxPoints ? capPoints(pts, maxPoints) : pts;
}

/* ---- route import formats ---- */

export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

export function parseGeoJson(obj) {
  const out = [];
  const walk = (g) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') (g.features || []).forEach((f) => walk(f && f.geometry));
    else if (g.type === 'Feature') walk(g.geometry);
    else if (g.type === 'GeometryCollection') (g.geometries || []).forEach(walk);
    else if (g.type === 'LineString') (g.coordinates || []).forEach((c) => out.push([c[1], c[0]]));
    else if (g.type === 'MultiLineString') (g.coordinates || []).forEach((l) => l.forEach((c) => out.push([c[1], c[0]])));
  };
  walk(obj);
  if (out.length < 2) throw new Error('no LineString found in that GeoJSON');
  return out;
}

/* browser only — uses DOMParser */
export function parseGpx(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('that file is not valid GPX/XML');
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    const nodes = Array.from(doc.getElementsByTagName(tag));
    if (nodes.length > 1) return nodes.map((n) => [Number(n.getAttribute('lat')), Number(n.getAttribute('lon'))]);
  }
  throw new Error('no track points found in that GPX');
}

/* accepts GPX, GeoJSON, a bare [[lat,lng],…] array, "lat,lng" lines,
   or a Google-style encoded polyline */
export function parseRouteText(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('nothing to parse');
  if (t.startsWith('<')) return parseGpx(t);
  if (t.startsWith('{') || t.startsWith('[')) {
    const obj = JSON.parse(t);
    return Array.isArray(obj) ? sanitizePoints(obj) : parseGeoJson(obj);
  }
  const lines = t.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  const asCoords = lines.map((l) => l.split(/[,\s]+/).map(Number));
  if (lines.length >= 2 && asCoords.every((a) => a.length >= 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]))) {
    return asCoords.map((a) => [a[0], a[1]]);
  }
  const decoded = decodePolyline(t);
  if (decoded.length < 2) throw new Error('could not read a route out of that');
  return decoded;
}
