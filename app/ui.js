'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { haversineMeters, pathLengthMeters, metersToMiles, parseRouteText, parseGpx, sanitizePoints } from '../lib/geo';

/* ---------------- helpers ---------------- */

const ORANGE = '#fc4c02';
const ROUTE_BLUE = '#1f6feb';
const TRAIL_COLORS = [ORANGE, '#0b8f5a', '#7048e8', '#d6336c'];

function trailColor(name, i) {
  return TRAIL_COLORS[i % TRAIL_COLORS.length] || ORANGE;
}

function fmtMiles(meters) {
  const mi = metersToMiles(meters);
  return mi < 0.1 ? `${Math.round(meters)} m` : `${mi.toFixed(1)} mi`;
}

const MOOD_SCORE = {
  '🤩': 5, '😄': 5, '💪': 5, '🔥': 5, '🚀': 5, '🥳': 5,
  '😀': 4, '🙂': 4, '😊': 4, '🦶': 4,
  '😅': 3, '😐': 3, '🤔': 3, '🌙': 3, '☀️': 3,
  '🥱': 2, '😴': 2, '🥵': 2, '😣': 2, '🌧️': 2,
  '😫': 1, '😭': 1, '💀': 1,
};
const EMOJI_PICKS = ['💪', '🔥', '😄', '🙂', '😅', '😐', '🥱', '🥵', '😫', '💀'];

async function api(payload, extra = {}) {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...extra,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `request failed (HTTP ${res.status}) — if you are on a long *-vercel.app deployment URL, use the-greatest-saunter.vercel.app instead`);
  if (!data) throw new Error('request failed — server sent a non-JSON response');
  return data;
}

function getPosition(timeout = 6000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
  });
}

function elapsedMs(timer, now) {
  if (!timer) return 0;
  return timer.accumMs + (timer.running && timer.lastStartTs ? Math.max(0, now - timer.lastStartTs) : 0);
}

function fmtHM(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return { h, m, s };
}

function fmtDurShort(ms) {
  const { h, m } = fmtHM(ms);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function ago(ts, now) {
  const d = Math.max(0, now - ts);
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ${Math.floor((d % 3600000) / 60000)}m ago`;
  return new Date(ts).toLocaleString();
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function moodScore(e) {
  return MOOD_SCORE[e] ?? 3;
}

/* downscale an image file to a JPEG blob (max 1600px) */
function downscale(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1600;
      let { width: w, height: h } = img;
      if (w > max || h > max) {
        const r = Math.min(max / w, max / h);
        w = Math.round(w * r);
        h = Math.round(h * r);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => { URL.revokeObjectURL(url); resolve(blob || file); },
        'image/jpeg',
        0.82
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/* ---------------- main ---------------- */

export default function Ui() {
  const [state, setState] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminCode, setAdminCode] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  /* live location sharing lives here (not in the admin panel) so it keeps
     running when the panel is closed — closing the overlay used to unmount
     the effect and silently kill the GPS watch */
  const [sharing, setSharing] = useState(false);
  const [shareName, setShareName] = useState('Evan');
  const [lastPost, setLastPost] = useState(null);
  const [shareErr, setShareErr] = useState('');
  const [geo, setGeo] = useState({ route: null, tracks: {} });
  const trackRef = useRef([]);
  const walkEpochRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) setState(await res.json());
    } catch {}
  }, []);

  /* map geometry is much heavier than the rest of the state, so it gets its
     own endpoint and a slower poll */
  const refreshGeo = useCallback(async () => {
    try {
      const res = await fetch('/api/geo', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setGeo({ route: data.route || null, tracks: data.tracks || {} });
      }
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const p = setInterval(refresh, 5000);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(p); clearInterval(t); };
  }, [refresh]);

  useEffect(() => {
    refreshGeo();
    const g = setInterval(refreshGeo, 20000);
    return () => clearInterval(g);
  }, [refreshGeo]);

  // a full reset bumps walkEpoch; drop breadcrumbs from before it so a phone
  // that is still sharing doesn't immediately redraw the trail we just erased
  useEffect(() => {
    const epoch = (state && state.walkEpoch) || 0;
    if (epoch <= walkEpochRef.current) return;
    walkEpochRef.current = epoch;
    trackRef.current = trackRef.current.filter((p) => p[2] >= epoch);
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('saunter_track_')) localStorage.removeItem(k);
      }
    } catch {}
  }, [state && state.walkEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const saved = localStorage.getItem('saunter_admin');
    if (saved) {
      setAdminCode(saved);
      api({ type: 'ping', adminCode: saved }).then((r) => setIsAdmin(!!r.ok)).catch(() => {});
    }
  }, []);

  const act = useCallback(async (payload) => {
    const data = await api(payload);
    if (data.state) setState(data.state);
    return data;
  }, []);

  useEffect(() => {
    if (!sharing) return;
    if (!navigator.geolocation) {
      setShareErr('no geolocation on this device');
      setSharing(false);
      return;
    }

    let coords = null;
    let lastSent = 0;
    let lastPersist = 0;
    let stopped = false;

    // breadcrumbs survive a page reload, so a mid-walk refresh doesn't lose the tail
    const storeKey = `saunter_track_${shareName}`;
    try {
      trackRef.current = sanitizePoints(JSON.parse(localStorage.getItem(storeKey) || '[]'))
        .filter((p) => p.length === 3 && p[2] >= walkEpochRef.current);
    } catch { trackRef.current = []; }

    const persist = (force = false) => {
      if (!force && Date.now() - lastPersist < 20000) return;
      lastPersist = Date.now();
      try { localStorage.setItem(storeKey, JSON.stringify(trackRef.current.slice(-3000))); } catch {}
    };

    const send = (force = false) => {
      if (!coords || stopped) return;
      trackRef.current = trackRef.current.filter((p) => p[2] >= walkEpochRef.current);
      if (!force && Date.now() - lastSent < 10000) return;
      lastSent = Date.now();
      api(
        {
          type: 'location_update',
          adminCode,
          name: shareName,
          lat: coords.lat,
          lng: coords.lng,
          // resend a tail rather than a single point: if the server reads a
          // stale copy of the track, the overlap fills the gap back in
          tail: trackRef.current.slice(-60),
        },
        { keepalive: true }
      )
        .then(() => { if (!stopped) { setLastPost(Date.now()); setShareErr(''); } })
        .catch((e) => { if (!stopped) setShareErr('location post: ' + e.message); });
    };

    // post on every fresh GPS fix (throttled to ~10s) so the pin follows the walk
    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        coords = { lat: p.coords.latitude, lng: p.coords.longitude };
        const pt = [coords.lat, coords.lng, Date.now()];
        const last = trackRef.current[trackRef.current.length - 1];
        // ~12m of movement, or a couple of minutes standing still, earns a breadcrumb
        if (!last || haversineMeters(last, pt) >= 12 || pt[2] - last[2] >= 120000) {
          trackRef.current.push(sanitizePoints([pt])[0]);
          persist();
        }
        send();
      },
      (err) => setShareErr('location: ' + err.message + (err.code === 1 ? ' — allow location access for this site in your browser settings' : '')),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
    // heartbeat in case the device stops emitting fixes while standing still
    const iv = setInterval(() => send(true), 15000);

    // phones suspend timers + GPS when the screen sleeps: hold a wake lock
    // while sharing, and post immediately when the tab becomes visible again
    let wakeLock = null;
    const acquireWakeLock = () => {
      try {
        navigator.wakeLock?.request('screen')
          .then((l) => { if (stopped) l.release().catch(() => {}); else wakeLock = l; })
          .catch(() => {});
      } catch {}
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        acquireWakeLock();
        send(true);
      }
    };
    acquireWakeLock();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      persist(true);
      navigator.geolocation.clearWatch(watchId);
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      try { wakeLock?.release(); } catch {}
    };
  }, [sharing, shareName, adminCode]);

  if (!state) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <div className="display" style={{ fontSize: 28, fontWeight: 800, fontStyle: 'italic', color: ORANGE }}>
          LOADING THE SAUNTER…
        </div>
      </div>
    );
  }

  const t = state.timer;
  const finished = t.finished;
  const elapsed = finished && t.finishedAt ? t.accumMs : elapsedMs(t, now);
  const activeWalkers = state.walkers.filter((w) => w.active);

  return (
    <>
      <div className="topbar">
        <div className="topbar-in">
          <span className="logo">🥾 The Greatest Saunter</span>
          {t.running && <span className="live-dot"><i />LIVE</span>}
          {finished && <span className="live-dot" style={{ background: 'rgba(0,0,0,.3)' }}>🏁 FINAL</span>}
          {sharing && (
            <span className="live-dot" style={{ background: 'rgba(0,90,20,.45)' }} title={shareErr || (lastPost ? `last pin posted ${ago(lastPost, now)}` : 'waiting for GPS fix…')}>
              🛰 {shareErr ? 'GPS ERROR' : lastPost ? `SHARING · ${shareName}` : 'GPS…'}
            </span>
          )}
          <button className="admin-btn" onClick={() => setAdminOpen((v) => !v)}>
            {adminOpen ? 'Close' : 'Admin'}
          </button>
        </div>
      </div>

      {finished && <div className="final-banner">🏁 The walk is complete — this page is snapped forever 🏁</div>}

      <Hero state={state} elapsed={elapsed} activeWalkers={activeWalkers} />

      <div className="wrap">
        <StatsGrid state={state} elapsed={elapsed} now={now} />
        <MapSection state={state} geo={geo} now={now} />
        <Donations state={state} act={act} finished={finished} now={now} />
        <Challenges state={state} act={act} finished={finished} isAdmin={isAdmin} adminCode={adminCode} />
        <MoodDashboard state={state} now={now} />
        <StepsChart state={state} />
        <Leaderboard state={state} now={now} />
        <FeedSection state={state} act={act} finished={finished} now={now} isAdmin={isAdmin} adminCode={adminCode} />
        <footer>
          Built with 🦶 for <b>The Greatest Saunter</b> — a 24-hour walk for fun (and for charity).
        </footer>
      </div>

      {adminOpen && (
        <AdminPanel
          state={state}
          act={act}
          now={now}
          adminCode={adminCode}
          setAdminCode={setAdminCode}
          isAdmin={isAdmin}
          setIsAdmin={setIsAdmin}
          close={() => setAdminOpen(false)}
          sharing={sharing}
          setSharing={setSharing}
          shareName={shareName}
          setShareName={setShareName}
          lastPost={lastPost}
          shareErr={shareErr}
          geo={geo}
          refreshGeo={refreshGeo}
        />
      )}
    </>
  );
}

/* ---------------- hero ---------------- */

function Hero({ state, elapsed, activeWalkers }) {
  const t = state.timer;
  const { h, m, s } = fmtHM(elapsed);
  const goalMs = (t.goalHours || 24) * 3600000;
  const pct = Math.min(100, (elapsed / goalMs) * 100);

  return (
    <div className="hero">
      <div className="wrap">
        <div className="hero-label">
          {t.finished ? 'Final time' : t.running ? 'Time on feet — walking now' : t.startedAt ? 'Time on feet — paused' : 'Waiting to start…'}
        </div>
        <div className="big-timer">
          {h}<small>H</small> {String(m).padStart(2, '0')}<small>M</small> <small style={{ fontSize: '.22em' }}>{String(s).padStart(2, '0')}S</small>
        </div>
        <div className="progress-outer"><div className="progress-inner" style={{ width: `${pct}%` }} /></div>
        <div className="progress-caption">
          <span>{pct.toFixed(1)}% OF {t.goalHours || 24} HOURS</span>
          <span>{Math.max(0, (t.goalHours || 24) - elapsed / 3600000).toFixed(1)}H TO GO</span>
        </div>
        <div className="walker-chips">
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: 2, alignSelf: 'center', opacity: 0.9 }}>
            {t.finished ? 'FINISHERS:' : 'WALKING NOW:'}
          </span>
          {activeWalkers.length === 0 && !t.finished && <span className="chip" style={{ opacity: 0.7 }}>nobody yet…</span>}
          {(t.finished ? state.walkers : activeWalkers).map((w) => (
            <span key={w.id} className="chip"><i />{w.name}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- stats ---------------- */

function StatsGrid({ state, elapsed, now }) {
  const miles = state.miles || 0;
  const elapsedMin = elapsed / 60000;
  let pace = '—';
  let mph = '—';
  if (miles > 0 && elapsedMin > 0) {
    const p = elapsedMin / miles;
    pace = `${Math.floor(p)}:${String(Math.round((p % 1) * 60)).padStart(2, '0')}`;
    mph = (miles / (elapsedMin / 60)).toFixed(1);
  }
  const lastSteps = state.steps.length ? state.steps[state.steps.length - 1].total : null;
  const steps = lastSteps ?? (miles > 0 ? Math.round(miles * 2100) : 0);
  const raised = state.donations.total;

  return (
    <section>
      <div className="stats-grid">
        <div className="stat orange"><div className="k">Miles walked</div><div className="v">{miles.toFixed(1)} <em>mi</em></div></div>
        <div className="stat"><div className="k">Avg pace</div><div className="v">{pace} <em>/mi</em></div></div>
        <div className="stat"><div className="k">Speed</div><div className="v">{mph} <em>mph</em></div></div>
        <div className="stat"><div className="k">Est. steps{lastSteps === null ? '*' : ''}</div><div className="v">{steps.toLocaleString()}</div></div>
        <div className="stat"><div className="k">Walking now</div><div className="v">{state.walkers.filter((w) => w.active).length}</div></div>
        <div className="stat orange"><div className="k">Raised</div><div className="v">${raised.toLocaleString()}</div></div>
      </div>
      {lastSteps === null && <div className="map-note">*steps estimated from miles (~2,100/mi) until an admin logs a real count</div>}
    </section>
  );
}

/* ---------------- map ---------------- */

function MapSection({ state, geo, now }) {
  const mapRef = useRef(null);
  const leafletRef = useRef(null);
  const layerRef = useRef(null);
  const geoLayerRef = useRef(null);
  const fittedRef = useRef(false);
  const [ready, setReady] = useState(false);

  const route = geo.route;
  const tracks = geo.tracks || {};
  const trackNames = Object.keys(tracks).sort();
  // popups only need "3m ago" to be roughly right — don't redraw every second
  const nowBucket = Math.floor(now / 30000);

  useEffect(() => {
    let cancelled = false;

    function ensureLeaflet(cb) {
      if (window.L) return cb();
      if (!document.getElementById('leaflet-css')) {
        const link = document.createElement('link');
        link.id = 'leaflet-css';
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
      }
      const existing = document.getElementById('leaflet-js');
      if (existing) {
        existing.addEventListener('load', cb);
        return;
      }
      const s = document.createElement('script');
      s.id = 'leaflet-js';
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = cb;
      document.body.appendChild(s);
    }

    ensureLeaflet(() => {
      if (cancelled || leafletRef.current || !mapRef.current) return;
      const L = window.L;
      const map = L.map(mapRef.current).setView([39.5, -98.35], 4);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);
      leafletRef.current = map;
      geoLayerRef.current = L.layerGroup().addTo(map); // route + trails, under the pins
      layerRef.current = L.layerGroup().addTo(map);
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (p) => { if (!fittedRef.current) map.setView([p.coords.latitude, p.coords.longitude], 13); },
          () => {},
          { timeout: 5000 }
        );
      }
      setReady(true);
    });

    return () => { cancelled = true; };
  }, []);

  /* planned route + walked trails */
  useEffect(() => {
    const L = window.L;
    const map = leafletRef.current;
    const layer = geoLayerRef.current;
    if (!L || !map || !layer) return;

    layer.clearLayers();
    const pts = [];

    if (route && route.points.length > 1) {
      L.polyline(route.points, { color: '#fff', weight: 8, opacity: 0.65, interactive: false }).addTo(layer);
      L.polyline(route.points, { color: ROUTE_BLUE, weight: 4, opacity: 0.85, dashArray: '9 9', lineCap: 'round' })
        .bindPopup(`<b>${escapeHtml(route.name || 'Planned route')}</b><br/>planned · ${fmtMiles(pathLengthMeters(route.points))}`)
        .addTo(layer);
      const start = route.points[0];
      const end = route.points[route.points.length - 1];
      L.marker(start, {
        icon: L.divIcon({ className: '', html: '<div class="pin-route start">A</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      }).bindPopup('Route start').addTo(layer);
      L.marker(end, {
        icon: L.divIcon({ className: '', html: '<div class="pin-route end">🏁</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      }).bindPopup('Route finish').addTo(layer);
      pts.push(...route.points.map((p) => [p[0], p[1]]));
    }

    trackNames.forEach((name, i) => {
      const pointsForName = tracks[name];
      if (!pointsForName || pointsForName.length < 2) return;
      const line = pointsForName.map((p) => [p[0], p[1]]);
      L.polyline(line, { color: '#fff', weight: 9, opacity: 0.7, interactive: false }).addTo(layer);
      L.polyline(line, { color: trailColor(name, i), weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' })
        .bindPopup(`<b>${escapeHtml(name)}</b><br/>actually walked · ${fmtMiles(pathLengthMeters(line))}`)
        .addTo(layer);
      pts.push(...line);
    });

    if (pts.length && !fittedRef.current) {
      fittedRef.current = true;
      map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
    }
  }, [route, tracks, trackNames.join('|'), ready]); // eslint-disable-line react-hooks/exhaustive-deps

  /* walker pins + pinned posts */
  useEffect(() => {
    const L = window.L;
    const map = leafletRef.current;
    const layer = layerRef.current;
    if (!L || !map || !layer) return;

    layer.clearLayers();
    const pts = [];

    Object.entries(state.locations || {}).forEach(([name, loc]) => {
      if (!loc || loc.lat == null) return;
      const age = now - (loc.ts || 0);
      if (age > 12 * 3600000) return; // a pin half a day old isn't a location anymore
      const stale = age > 10 * 60000;
      const icon = L.divIcon({ className: '', html: `<div class="pin-walker${stale ? ' stale' : ''}">${escapeHtml(name[0] || '?')}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
      L.marker([loc.lat, loc.lng], { icon, zIndexOffset: 1000 })
        .bindPopup(`<b>${escapeHtml(name)}</b><br/>${stale ? 'last seen' : 'live location'} · ${ago(loc.ts, now)}`)
        .addTo(layer);
      pts.push([loc.lat, loc.lng]);
    });

    (state.events || []).forEach((ev) => {
      if (ev.lat == null || ev.lng == null) return;
      const glyph = ev.kind === 'photo' ? '📷' : ev.kind === 'emoji' ? ev.emoji : '💬';
      const icon = L.divIcon({ className: '', html: `<div class="pin-emoji">${glyph}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      let html = `<b>${escapeHtml(ev.name || '')}</b> · ${fmtClock(ev.ts)}`;
      if (ev.text) html += `<br/>${escapeHtml(ev.text)}`;
      if (ev.kind === 'emoji') html += `<br/><span style="font-size:26px">${ev.emoji}</span>`;
      if (ev.photoUrl) html += `<br/><img src="${ev.photoUrl}" style="max-width:180px;border-radius:6px;margin-top:4px"/>`;
      L.marker([ev.lat, ev.lng], { icon }).bindPopup(html).addTo(layer);
      pts.push([ev.lat, ev.lng]);
    });

    if (pts.length && !fittedRef.current) {
      fittedRef.current = true;
      map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    }
  }, [state, nowBucket, ready]);

  const routeMeters = route ? pathLengthMeters(route.points) : 0;

  return (
    <section>
      <div className="sec-title">Live Map <span className="sub">planned route, the trail we actually walked, and pinned posts</span></div>
      <div className="card" style={{ padding: 8 }}>
        <div id="map" ref={mapRef} />
        <div className="map-legend">
          {route && (
            <span><i className="swatch route" /> {route.name || 'Planned route'} · {fmtMiles(routeMeters)} planned</span>
          )}
          {trackNames.map((name, i) => (
            <span key={name}>
              <i className="swatch trail" style={{ borderTopColor: trailColor(name, i) }} /> {name} walked · {fmtMiles(pathLengthMeters(tracks[name]))}
            </span>
          ))}
          {!route && trackNames.length === 0 && (
            <span style={{ color: 'var(--ink-3)' }}>No route loaded yet — admins can upload a GPX in the admin panel.</span>
          )}
        </div>
      </div>
      {state.config.mapsEmbed && (
        <div className="card" style={{ padding: 8, marginTop: 10 }}>
          <iframe
            src={state.config.mapsEmbed}
            style={{ width: '100%', height: 340, border: 0, borderRadius: 8 }}
            allowFullScreen
            loading="lazy"
            title="Google Maps shared location"
          />
        </div>
      )}
      <div className="map-note">
        The dashed blue line is the route we planned; the solid line is where we’ve actually walked, drawn from the
        walkers’ live GPS breadcrumbs. Pulsing pins are walkers streaming live location right now.
        Emoji / 📷 / 💬 pins are crowd posts pinned where they were sent.
      </div>
    </section>
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- donations ---------------- */

function Donations({ state, act, finished, now }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const { total, goal } = state.donations;
  const pct = Math.min(100, (total / (goal || 1)) * 100);
  const donateUrl = state.config.donateUrl;

  useEffect(() => { setName(localStorage.getItem('saunter_name') || ''); }, []);

  async function submit() {
    setMsg('');
    try {
      localStorage.setItem('saunter_name', name);
      await act({ type: 'donate', name, amount: Number(amount), text: note });
      setAmount(''); setNote('');
      setMsg('Thank you!! 💚 The tracker just went up.');
    } catch (e) { setMsg('err:' + e.message); }
  }

  const recent = (state.events || []).filter((e) => e.kind === 'donation').slice(-4).reverse();

  return (
    <section>
      <div className="sec-title">Fundraiser <span className="sub">every dollar goes to charity</span></div>
      <div className="card">
        <div className="don-total">${total.toLocaleString()}</div>
        <div style={{ color: 'var(--ink-3)', fontSize: 13, fontWeight: 600 }}>raised of ${goal.toLocaleString()} goal</div>
        <div className="don-bar-outer"><div className="don-bar-inner" style={{ width: `${pct}%` }} /></div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{pct.toFixed(0)}% of goal</div>

        {!finished && (
          <>
            <div className="row" style={{ marginTop: 14 }}>
              {donateUrl && (
                <a href={donateUrl} target="_blank" rel="noreferrer">
                  <button className="btn">Donate 💸</button>
                </a>
              )}
            </div>
            <label className="lbl">Log your donation (bumps the tracker)</label>
            <div className="row">
              <input type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 180 }} />
              <input type="number" placeholder="$ amount" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 120 }} min="1" />
              <input type="text" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 240 }} />
              <button className="btn ghost" onClick={submit} disabled={!amount || Number(amount) <= 0}>Add to tracker</button>
            </div>
            {msg && <div className={`msg ${msg.startsWith('err:') ? 'err' : ''}`}>{msg.replace(/^err:/, '')}</div>}
            {!donateUrl && (
              <div className="map-note">Admins: set a donation link (Venmo / GoFundMe) in the admin panel so people can actually pay here.</div>
            )}
          </>
        )}

        {recent.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {recent.map((d) => (
              <div key={d.id} style={{ fontSize: 13, padding: '3px 0', color: 'var(--ink-2)' }}>
                💚 <b>{d.name}</b> donated <b>${d.amount}</b>{d.text ? ` — “${d.text}”` : ''} <span style={{ color: 'var(--ink-3)' }}>({ago(d.ts, now)})</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------- challenges ---------------- */

function Challenges({ state, act, finished, isAdmin, adminCode }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => { setName(localStorage.getItem('saunter_name') || ''); }, []);

  async function submit() {
    setMsg('');
    try {
      localStorage.setItem('saunter_name', name);
      await act({ type: 'challenge_add', name, text, amount: Number(amount) });
      setText(''); setAmount('');
      setMsg('Challenge posted! 😈');
    } catch (e) { setMsg('err:' + e.message); }
  }

  const open = state.challenges.filter((c) => !c.done);
  const done = state.challenges.filter((c) => c.done);

  return (
    <section>
      <div className="sec-title">Challenges <span className="sub">dare the walkers — pay up when they deliver</span></div>
      <div className="card">
        {state.challenges.length === 0 && <div className="chart-empty">No challenges yet. Be the first to make them suffer (for charity). 😈</div>}
        {[...open, ...done].map((c) => (
          <div key={c.id} className={`challenge ${c.done ? 'done' : ''}`}>
            <div className="amt">${c.amount}</div>
            <div className="txt">
              {c.text}
              <div className="by">dared by {c.by}</div>
            </div>
            {c.done && <span className="badge-done">DONE ✓</span>}
            {!c.done && isAdmin && !finished && (
              <button className="btn small" onClick={() => act({ type: 'challenge_done', id: c.id, adminCode })}>Mark done</button>
            )}
          </div>
        ))}

        {!finished && (
          <>
            <label className="lbl">Add a challenge</label>
            <div className="row">
              <input type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 160 }} />
              <input type="text" placeholder='e.g. "take a selfie with a dog"' value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              <input type="number" placeholder="$" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 90 }} min="1" />
              <button className="btn ghost" onClick={submit} disabled={!text || !amount}>Post dare</button>
            </div>
            {msg && <div className={`msg ${msg.startsWith('err:') ? 'err' : ''}`}>{msg.replace(/^err:/, '')}</div>}
          </>
        )}
      </div>
    </section>
  );
}

/* ---------------- mood dashboard ---------------- */

function MoodDashboard({ state, now }) {
  const emojis = (state.events || []).filter((e) => e.kind === 'emoji');
  const latest = emojis[emojis.length - 1];

  const { points, path, labels } = useMemo(() => {
    if (!emojis.length) return { points: [], path: '', labels: [] };
    const t0 = state.timer.startedAt || emojis[0].ts;
    const t1 = Math.max(now, emojis[emojis.length - 1].ts);
    const span = Math.max(3600000, t1 - t0);
    // hourly buckets
    const buckets = new Map();
    for (const e of emojis) {
      const b = Math.floor((e.ts - t0) / 3600000);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(moodScore(e.emoji));
    }
    const W = 640, H = 200, L = 40, R = 20, T = 14, B = 26;
    const xFor = (ts) => L + ((ts - t0) / span) * (W - L - R);
    const yFor = (v) => T + (1 - (v - 1) / 4) * (H - T - B);
    const pts = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, arr]) => {
        const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
        return { x: xFor(t0 + (b + 0.5) * 3600000), y: yFor(avg), avg, n: arr.length, hour: b };
      });
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const hourTicks = [];
    const totalHours = Math.ceil(span / 3600000);
    const step = totalHours > 12 ? 4 : totalHours > 6 ? 2 : 1;
    for (let hh = 0; hh <= totalHours; hh += step) {
      hourTicks.push({ x: xFor(t0 + hh * 3600000), label: `${hh}h` });
    }
    return { points: pts, path: d, labels: hourTicks };
  }, [state, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = {};
  for (const e of emojis) counts[e.emoji] = (counts[e.emoji] || 0) + 1;
  const dist = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <section>
      <div className="sec-title">Mood Dashboard</div>
      <div className="card">
        {latest ? (
          <div className="mood-current">
            <span className="e">{latest.emoji}</span>
            <div>
              <div style={{ fontWeight: 700 }}>Current vibe</div>
              <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>from {latest.name}, {ago(latest.ts, now)}</div>
            </div>
          </div>
        ) : (
          <div className="chart-empty">No vibes logged yet — drop an emoji in the feed below! 🎭</div>
        )}

        {points.length > 0 && (
          <svg className="chart-svg" viewBox="0 0 640 200" role="img" aria-label="Average mood per hour of the walk, from 1 (rough) to 5 (great)">
            {[1, 2, 3, 4, 5].map((v) => {
              const y = 14 + (1 - (v - 1) / 4) * 160;
              return (
                <g key={v}>
                  <line x1="40" x2="620" y1={y} y2={y} stroke="#eee" strokeWidth="1" />
                  <text x="30" y={y + 5} fontSize="13" textAnchor="middle">{['😫', '🥱', '😐', '🙂', '🤩'][v - 1]}</text>
                </g>
              );
            })}
            {labels.map((l, i) => (
              <text key={i} x={l.x} y="196" fontSize="10" fill="#8a8a8a" textAnchor="middle">{l.label}</text>
            ))}
            <path d={path} fill="none" stroke={ORANGE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="4.5" fill={ORANGE} stroke="#fff" strokeWidth="2">
                <title>{`hour ${p.hour}: avg ${p.avg.toFixed(1)}/5 (${p.n} vibe${p.n > 1 ? 's' : ''})`}</title>
              </circle>
            ))}
            {points.length > 0 && (
              <text
                x={Math.min(points[points.length - 1].x + 8, 600)}
                y={points[points.length - 1].y - 8}
                fontSize="12" fontWeight="700" fill={ORANGE}
              >
                {points[points.length - 1].avg.toFixed(1)}
              </text>
            )}
          </svg>
        )}

        {dist.length > 0 && (
          <div className="mood-dist">
            {dist.map(([e, n]) => <span key={e}>{e} ×{n}</span>)}
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------- steps chart ---------------- */

function StepsChart({ state }) {
  const entries = state.steps || [];

  const chart = useMemo(() => {
    if (entries.length < 2) return null;
    const t0 = state.timer.startedAt || entries[0].ts;
    const t1 = entries[entries.length - 1].ts;
    const span = Math.max(1, t1 - t0);
    const maxV = Math.max(...entries.map((e) => e.total));
    const W = 640, H = 200, L = 56, R = 20, T = 14, B = 26;
    const xFor = (ts) => L + ((ts - t0) / span) * (W - L - R);
    const yFor = (v) => T + (1 - v / maxV) * (H - T - B);
    const pts = entries.map((e) => ({ x: xFor(e.ts), y: yFor(e.total), v: e.total, ts: e.ts }));
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${path} L${pts[pts.length - 1].x.toFixed(1)},${H - B} L${pts[0].x.toFixed(1)},${H - B} Z`;
    const yTicks = [0, 0.5, 1].map((f) => ({ y: yFor(maxV * f), label: Math.round(maxV * f).toLocaleString() }));
    return { pts, path, area, yTicks, H, B };
  }, [entries, state.timer.startedAt]);

  return (
    <section>
      <div className="sec-title">Step count <span className="sub">manually logged along the way</span></div>
      <div className="card">
        {!chart ? (
          <div className="chart-empty">
            {entries.length === 1
              ? `First reading logged: ${entries[0].total.toLocaleString()} steps. One more and you get a chart.`
              : 'No step readings yet — admins can log a running total from a phone/watch in the admin panel.'}
          </div>
        ) : (
          <svg className="chart-svg" viewBox="0 0 640 200" role="img" aria-label="Cumulative steps over the walk">
            {chart.yTicks.map((tk, i) => (
              <g key={i}>
                <line x1="56" x2="620" y1={tk.y} y2={tk.y} stroke="#eee" strokeWidth="1" />
                <text x="50" y={tk.y + 4} fontSize="10" fill="#8a8a8a" textAnchor="end">{tk.label}</text>
              </g>
            ))}
            <path d={chart.area} fill={ORANGE} opacity="0.12" />
            <path d={chart.path} fill="none" stroke={ORANGE} strokeWidth="2" strokeLinejoin="round" />
            {chart.pts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="4" fill={ORANGE} stroke="#fff" strokeWidth="2">
                <title>{`${p.v.toLocaleString()} steps at ${fmtClock(p.ts)}`}</title>
              </circle>
            ))}
            <text
              x={Math.min(chart.pts[chart.pts.length - 1].x, 560)}
              y={chart.pts[chart.pts.length - 1].y - 10}
              fontSize="13" fontWeight="700" fill={ORANGE} textAnchor="middle"
            >
              {chart.pts[chart.pts.length - 1].v.toLocaleString()}
            </text>
          </svg>
        )}
      </div>
    </section>
  );
}

/* ---------------- leaderboard ---------------- */

function Leaderboard({ state, now }) {
  const frozen = state.timer.finished;
  const rows = state.walkers
    .map((w) => ({ ...w, ms: w.totalMs + (w.active && !frozen ? Math.max(0, now - w.joinedAt) : 0) }))
    .sort((a, b) => b.ms - a.ms);
  const max = rows.length ? Math.max(...rows.map((r) => r.ms), 1) : 1;

  return (
    <section>
      <div className="sec-title">Walker Leaderboard <span className="sub">total time on feet</span></div>
      <div className="card">
        {rows.length === 0 && <div className="chart-empty">No walkers yet — admins add them when people join.</div>}
        {rows.map((r, i) => (
          <div key={r.id} className="lb-row">
            <div className={`lb-rank ${i === 0 ? 'top' : ''}`}>{i + 1}</div>
            <div className="lb-name">{r.name} {r.active && !frozen && <span className="lb-active">● walking</span>}</div>
            <div className="lb-bar"><i style={{ width: `${(r.ms / max) * 100}%` }} /></div>
            <div className="lb-time">{fmtDurShort(r.ms)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- feed + composer ---------------- */

function FeedSection({ state, act, finished, now, isAdmin, adminCode }) {
  const [tab, setTab] = useState('comment');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [caption, setCaption] = useState('');
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);

  useEffect(() => { setName(localStorage.getItem('saunter_name') || ''); }, []);

  async function locate() {
    return pin ? await getPosition() : null;
  }

  async function postComment() {
    setBusy(true); setMsg('');
    try {
      localStorage.setItem('saunter_name', name);
      const loc = await locate();
      await act({ type: 'comment', name, text, ...(loc || {}) });
      setText(''); setMsg('Posted! 💬');
    } catch (e) { setMsg('err:' + e.message); }
    setBusy(false);
  }

  async function postEmoji(emoji) {
    setBusy(true); setMsg('');
    try {
      localStorage.setItem('saunter_name', name);
      const loc = await locate();
      await act({ type: 'emoji', name, emoji, ...(loc || {}) });
      setMsg(`Vibe logged ${emoji}`);
    } catch (e) { setMsg('err:' + e.message); }
    setBusy(false);
  }

  async function postPhoto() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true); setMsg('Uploading…');
    try {
      localStorage.setItem('saunter_name', name);
      const blob = await downscale(file);
      const fd = new FormData();
      fd.append('file', new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
      const up = await fetch('/api/upload', { method: 'POST', body: fd });
      const upData = await up.json();
      if (!up.ok) throw new Error(upData.error || 'upload failed');
      const loc = await locate();
      await act({ type: 'photo', name, photoUrl: upData.url, text: caption, ...(loc || {}) });
      setCaption(''); fileRef.current.value = '';
      setMsg('Photo posted! 📷');
    } catch (e) { setMsg('err:' + e.message); }
    setBusy(false);
  }

  const events = [...(state.events || [])].sort((a, b) => b.ts - a.ts);

  return (
    <section>
      <div className="sec-title">Live Feed</div>

      {!finished && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            {['comment', 'vibe', 'photo'].map((tb) => (
              <button
                key={tb}
                className={`btn small ${tab === tb ? '' : 'ghost'}`}
                onClick={() => setTab(tb)}
              >
                {tb === 'comment' ? '💬 Comment' : tb === 'vibe' ? '🎭 Vibe' : '📷 Photo'}
              </button>
            ))}
          </div>
          <div className="row">
            <input type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 180 }} />
            <label style={{ fontSize: 13, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} style={{ width: 'auto' }} />
              📍 pin to map
            </label>
          </div>

          {tab === 'comment' && (
            <>
              <label className="lbl">Say something encouraging (or not)</label>
              <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="You got this!! Only 19 hours left!!" />
              <div style={{ marginTop: 8 }}>
                <button className="btn" onClick={postComment} disabled={busy || !text.trim()}>Post comment</button>
              </div>
            </>
          )}

          {tab === 'vibe' && (
            <>
              <label className="lbl">How are we feeling?</label>
              <div className="emoji-row">
                {EMOJI_PICKS.map((e) => (
                  <button key={e} onClick={() => postEmoji(e)} disabled={busy}>{e}</button>
                ))}
              </div>
            </>
          )}

          {tab === 'photo' && (
            <>
              <label className="lbl">Upload a photo from the route</label>
              <input type="file" accept="image/*" ref={fileRef} style={{ fontSize: 13 }} />
              <label className="lbl">Caption (optional)</label>
              <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="mile 14, morale... complicated" />
              <div style={{ marginTop: 8 }}>
                <button className="btn" onClick={postPhoto} disabled={busy}>Upload &amp; post</button>
              </div>
            </>
          )}
          {msg && <div className={`msg ${msg.startsWith('err:') ? 'err' : ''}`}>{msg.replace(/^err:/, '')}</div>}
        </div>
      )}

      <div className="feed">
        {events.length === 0 && <div className="chart-empty">Nothing yet. The saunter awaits.</div>}
        {events.map((ev) => (
          <div key={ev.id} className={`feed-item ${ev.kind === 'donation' || ev.kind === 'challenge_done' ? 'donation' : ''} ${ev.kind === 'status' ? 'status' : ''}`}>
            <div className="ico">
              {{ comment: '💬', emoji: ev.emoji || '🎭', photo: '📷', status: '📣', donation: '💚', challenge: '😈', challenge_done: '✅' }[ev.kind] || '•'}
            </div>
            <div className="body">
              <span className="who">{ev.name}</span>
              <span className="when">{ago(ev.ts, now)}{ev.lat != null ? ' · 📍' : ''}</span>
              {ev.kind === 'emoji'
                ? <div className="txt"><span className="big-emoji">{ev.emoji}</span></div>
                : ev.kind === 'donation'
                  ? <div className="txt">donated <b>${ev.amount}</b>{ev.text ? ` — “${ev.text}”` : ''}</div>
                  : ev.text ? <div className="txt">{ev.text}</div> : null}
              {ev.photoUrl && <img src={ev.photoUrl} alt={ev.text || 'walk photo'} loading="lazy" />}
            </div>
            {isAdmin && (
              <button
                className="btn small ghost"
                title="delete"
                onClick={() => act({ type: 'event_delete', id: ev.id, adminCode })}
                style={{ alignSelf: 'flex-start' }}
              >✕</button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- admin panel ---------------- */

function AdminPanel({ state, act, now, adminCode, setAdminCode, isAdmin, setIsAdmin, close, sharing, setSharing, shareName, setShareName, lastPost, shareErr, geo, refreshGeo }) {
  const [code, setCode] = useState(adminCode);
  const [miles, setMiles] = useState('');
  const [steps, setSteps] = useState('');
  const [newWalker, setNewWalker] = useState('');
  const [donateUrl, setDonateUrl] = useState(state.config.donateUrl || '');
  const [goal, setGoal] = useState(String(state.donations.goal || ''));
  const [mapsEmbed, setMapsEmbed] = useState(state.config.mapsEmbed || '');
  const [msg, setMsg] = useState('');
  const [routeName, setRouteName] = useState('');
  const [routePaste, setRoutePaste] = useState('');
  const [routeBusy, setRouteBusy] = useState(false);
  const routeFileRef = useRef(null);
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetFundraiser, setResetFundraiser] = useState(true);
  const [resetRoute, setResetRoute] = useState(false);

  async function login() {
    setMsg('');
    try {
      const r = await api({ type: 'ping', adminCode: code });
      if (r.ok) {
        setIsAdmin(true);
        setAdminCode(code);
        localStorage.setItem('saunter_admin', code);
        setMsg('Logged in ✔');
      } else setMsg('err:Wrong code');
    } catch (e) { setMsg('err:' + e.message); }
  }

  const doAct = async (payload, okMsg) => {
    setMsg('');
    try {
      await act({ ...payload, adminCode });
      if (okMsg) setMsg(okMsg);
    } catch (e) { setMsg('err:' + e.message); }
  };

  async function saveRoute(points, sourceLabel) {
    setRouteBusy(true);
    setMsg('');
    try {
      const res = await act({ type: 'route_set', adminCode, name: routeName || sourceLabel, points });
      setRoutePaste('');
      if (routeFileRef.current) routeFileRef.current.value = '';
      await refreshGeo();
      setMsg(`Route loaded — ${res.points} points on the map 🗺`);
    } catch (e) { setMsg('err:' + e.message); }
    setRouteBusy(false);
  }

  async function routeFromFile() {
    const file = routeFileRef.current?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const points = /\.gpx$/i.test(file.name) ? parseGpx(text) : parseRouteText(text);
      await saveRoute(points, file.name.replace(/\.[^.]+$/, ''));
    } catch (e) { setMsg('err:' + e.message); }
  }

  async function routeFromPaste() {
    try {
      await saveRoute(parseRouteText(routePaste), 'Planned route');
    } catch (e) { setMsg('err:' + e.message); }
  }

  async function doFullReset() {
    const wipes = [
      'the clock (back to 0:00)',
      'miles, steps and walkers',
      'every feed post and photo',
      'all live pins and the walked trail',
      resetFundraiser ? `the donation total (${state.donations.total.toLocaleString()}) and all challenges` : null,
      resetRoute ? 'the planned route' : null,
    ].filter(Boolean);
    if (!confirm(`COMPLETE RESET — this permanently erases:\n\n· ${wipes.join('\n· ')}\n\nYour donate link, goal and map settings are kept. This cannot be undone. Continue?`)) return;
    setSharing(false);
    await doAct({ type: 'full_reset', resetFundraiser, resetRoute }, 'Everything reset — back to 0:00 🧼');
    setResetConfirm('');
    await refreshGeo();
  }

  const routePoints = geo.route ? geo.route.points.length : 0;
  const routeMiles = geo.route ? fmtMiles(pathLengthMeters(geo.route.points)) : null;

  const t = state.timer;

  if (!isAdmin) {
    return (
      <div className="admin-panel">
        <div className="admin-grid">
          <div className="admin-box">
            <h4>Admin login</h4>
            <div className="row">
              <input type="text" placeholder="admin code" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} />
              <button className="btn" onClick={login}>Enter</button>
              <button className="btn ghost" onClick={close}>Close</button>
            </div>
            {msg && <div className={`msg ${msg.startsWith('err:') ? 'err' : ''}`}>{msg.replace(/^err:/, '')}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-panel">
      <div className="admin-grid">
        <div className="admin-box">
          <h4>⏱ Timer</h4>
          <div className="row">
            {!t.running && !t.finished && <button className="btn" onClick={() => doAct({ type: 'timer_start' }, 'Clock started!')}>▶ Start</button>}
            {t.running && <button className="btn dark" onClick={() => doAct({ type: 'timer_stop' }, 'Paused')}>⏸ Pause</button>}
            {!t.finished && t.startedAt && (
              <button
                className="btn ghost"
                onClick={() => { if (confirm('Finish the walk and freeze the page FOREVER?')) doAct({ type: 'timer_finish' }, 'Snapped forever 🏁'); }}
              >🏁 Finish</button>
            )}
            {t.finished && <button className="btn ghost" onClick={() => doAct({ type: 'timer_unfinish' }, 'Un-finished')}>Undo finish</button>}
            {!t.finished && t.startedAt && !t.running && (
              <button
                className="btn ghost small"
                onClick={() => { if (confirm('Reset the clock to 0:00? (false-start fix)')) doAct({ type: 'timer_reset' }, 'Clock reset'); }}
              >↺ Reset</button>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6 }}>
            elapsed: {fmtDurShort(elapsedMs(t, now))}{t.finished ? ' (FINAL)' : t.running ? ' (running)' : ' (paused)'}
          </div>
        </div>

        <div className="admin-box">
          <h4>📍 Stream my location</h4>
          <div className="row">
            <select value={shareName} onChange={(e) => setShareName(e.target.value)} style={{ maxWidth: 120 }} disabled={sharing}>
              <option>Evan</option>
              <option>Ganesh</option>
            </select>
            <button className={`btn ${sharing ? 'dark' : ''}`} onClick={() => setSharing((v) => !v)}>
              {sharing ? '⏹ Stop sharing' : '🛰 Start sharing'}
            </button>
            <button className="btn small ghost" onClick={() => doAct({ type: 'location_clear' }, 'All pins cleared')} title="remove every walker pin from the map">
              🧹 Clear pins
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6 }}>
            {sharing
              ? shareErr
                ? <span style={{ color: '#c62828', fontWeight: 700 }}>⚠ {shareErr}</span>
                : lastPost
                  ? <span style={{ color: 'var(--good)', fontWeight: 700 }}>● sharing as {shareName} — last pin posted {ago(lastPost, now)}</span>
                  : 'waiting for GPS fix… (allow location access if prompted)'
              : 'Posts your pin as you move (every ~10–15s). Sharing keeps running when this panel is closed — the 🛰 badge up top shows it’s live.'}
          </div>
        </div>

        <div className="admin-box">
          <h4>🗺 Planned route</h4>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
            {geo.route
              ? <span style={{ color: 'var(--good)', fontWeight: 700 }}>● “{geo.route.name}” loaded — {routePoints} points, {routeMiles}</span>
              : 'No route on the map yet.'}
          </div>
          <label className="lbl">Upload a GPX or GeoJSON</label>
          <input type="file" accept=".gpx,.geojson,.json,application/gpx+xml,application/geo+json,application/json" ref={routeFileRef} style={{ fontSize: 13 }} />
          <div style={{ marginTop: 6 }}>
            <button className="btn small" onClick={routeFromFile} disabled={routeBusy}>Load file</button>
          </div>
          <label className="lbl">…or paste GeoJSON, an encoded polyline, or “lat,lng” lines</label>
          <textarea
            value={routePaste}
            onChange={(e) => setRoutePaste(e.target.value)}
            placeholder={'40.7484,-73.9857\n40.7580,-73.9855\n40.7614,-73.9776'}
            style={{ minHeight: 70 }}
          />
          <label className="lbl">Route name (optional)</label>
          <input type="text" value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="The Big Loop" style={{ maxWidth: 200 }} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={routeFromPaste} disabled={routeBusy || !routePaste.trim()}>Save route</button>
            {geo.route && (
              <button
                className="btn small ghost"
                onClick={() => { if (confirm('Remove the planned route from the map?')) doAct({ type: 'route_clear' }, 'Route removed').then(refreshGeo); }}
              >Clear route</button>
            )}
            <button
              className="btn small ghost"
              onClick={() => { if (confirm('Erase the walked trail? This deletes the GPS breadcrumbs for every walker.')) doAct({ type: 'track_clear' }, 'Trail erased').then(refreshGeo); }}
            >Erase trail</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6 }}>
            Export a GPX from Strava, Gaia, onthegomap or Google&nbsp;Earth and drop it in — the trail we actually walk
            draws itself from the live GPS pings.
          </div>
        </div>

        <div className="admin-box">
          <h4>🥾 Miles &amp; steps</h4>
          <div className="row">
            <input type="number" placeholder={`miles (now: ${state.miles})`} value={miles} onChange={(e) => setMiles(e.target.value)} style={{ maxWidth: 150 }} step="0.1" />
            <button className="btn small" onClick={() => { doAct({ type: 'set_miles', miles: Number(miles) }, 'Miles updated'); setMiles(''); }} disabled={miles === ''}>Set</button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <input type="number" placeholder="total steps so far" value={steps} onChange={(e) => setSteps(e.target.value)} style={{ maxWidth: 150 }} />
            <button className="btn small" onClick={() => { doAct({ type: 'steps_add', total: Number(steps) }, 'Steps logged'); setSteps(''); }} disabled={steps === ''}>Log</button>
          </div>
        </div>

        <div className="admin-box">
          <h4>🚶 Walkers</h4>
          <div className="row">
            <input type="text" placeholder="name" value={newWalker} onChange={(e) => setNewWalker(e.target.value)} style={{ maxWidth: 150 }} />
            <button className="btn small" onClick={() => { doAct({ type: 'walker_add', name: newWalker }, 'Walker added'); setNewWalker(''); }} disabled={!newWalker.trim()}>+ Joined</button>
          </div>
          {state.walkers.map((w) => (
            <div key={w.id} className="walker-admin-row">
              <span style={{ flex: 1 }}>{w.name} {w.active ? '🟢' : '⚪'}</span>
              {w.active
                ? <button className="btn small ghost" onClick={() => doAct({ type: 'walker_leave', id: w.id })}>left</button>
                : <button className="btn small ghost" onClick={() => doAct({ type: 'walker_rejoin', id: w.id })}>re-join</button>}
            </div>
          ))}
        </div>

        <div className="admin-box">
          <h4>⚙️ Fundraiser &amp; map config</h4>
          <label className="lbl">Donation link (Venmo / GoFundMe)</label>
          <input type="url" value={donateUrl} onChange={(e) => setDonateUrl(e.target.value)} placeholder="https://venmo.com/…" />
          <label className="lbl">Goal ($)</label>
          <input type="number" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <label className="lbl">Google Maps embed URL (optional fallback)</label>
          <input type="url" value={mapsEmbed} onChange={(e) => setMapsEmbed(e.target.value)} placeholder="https://www.google.com/maps/embed?…" />
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => doAct({ type: 'config_set', donateUrl, mapsEmbed, goal: Number(goal) }, 'Config saved')}>Save</button>
          </div>
        </div>

        <div className="admin-box danger">
          <h4>☢️ Complete reset</h4>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
            Puts the whole page back to a clean slate: clock to 0:00, no miles, steps, walkers,
            feed posts, live pins or walked trail. Your donate link, goal and map settings are kept.
          </div>
          <label style={{ fontSize: 13, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={resetFundraiser} onChange={(e) => setResetFundraiser(e.target.checked)} style={{ width: 'auto' }} />
            also reset donations (${state.donations.total.toLocaleString()}) &amp; challenges
          </label>
          <label style={{ fontSize: 13, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <input type="checkbox" checked={resetRoute} onChange={(e) => setResetRoute(e.target.checked)} style={{ width: 'auto' }} />
            also remove the planned route
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <input
              type="text"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="type RESET"
              style={{ maxWidth: 130 }}
            />
            <button className="btn small danger" onClick={doFullReset} disabled={resetConfirm.trim().toUpperCase() !== 'RESET'}>
              Reset everything
            </button>
          </div>
        </div>

        <div className="admin-box">
          <h4>Session</h4>
          <div className="row">
            <button className="btn ghost small" onClick={() => { localStorage.removeItem('saunter_admin'); setIsAdmin(false); setAdminCode(''); setSharing(false); }}>Log out</button>
            <button className="btn small dark" onClick={close}>Close panel</button>
          </div>
          {msg && <div className={`msg ${msg.startsWith('err:') ? 'err' : ''}`}>{msg.replace(/^err:/, '')}</div>}
        </div>
      </div>
    </div>
  );
}
