import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  readState, writeState, writeLocation, clearLocations,
  writeRoute, clearRoute, readTrack, writeTrack, clearTracks,
} from '../../../lib/store';
import { sanitizePoints, capPoints, mergeTrack } from '../../../lib/geo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ADMIN_CODE = process.env.ADMIN_CODE || 'saunter24';

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};
const coord = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function addEvent(state, ev) {
  state.events.push({ id: randomUUID(), ts: Date.now(), ...ev });
  if (state.events.length > 800) state.events = state.events.slice(-800);
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const { type } = body || {};
  const isAdmin = typeof body.adminCode === 'string' && body.adminCode.trim() === ADMIN_CODE;

  if (type === 'ping') {
    return NextResponse.json({ ok: isAdmin });
  }

  const adminTypes = new Set([
    'timer_start', 'timer_stop', 'timer_finish', 'timer_unfinish', 'timer_reset',
    'set_miles', 'steps_add', 'walker_add', 'walker_leave', 'walker_rejoin',
    'challenge_done', 'config_set', 'location_update', 'location_clear', 'event_delete',
    'route_set', 'route_clear', 'track_clear',
  ]);
  if (adminTypes.has(type) && !isAdmin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const now = Date.now();

  // high-frequency ping: writes its own blob, never touches shared state
  if (type === 'location_update') {
    const name = str(body.name, 40);
    const lat = coord(body.lat);
    const lng = coord(body.lng);
    if (!name || lat === null || lng === null) return NextResponse.json({ error: 'bad location' }, { status: 400 });
    try {
      await writeLocation(name, { lat, lng, ts: now });
      // the phone re-sends a tail of recent breadcrumbs; merge it into the walked track
      const tail = sanitizePoints(body.tail, 400).filter((p) => p.length === 3);
      let trackPoints = null;
      if (tail.length) {
        const merged = mergeTrack(await readTrack(name), tail);
        await writeTrack(name, merged);
        trackPoints = merged.length;
      }
      return NextResponse.json({ ok: true, trackPoints });
    } catch (e) {
      return NextResponse.json({ error: 'location write failed: ' + (e.message || e) }, { status: 500 });
    }
  }

  // map geometry also lives outside shared state
  if (type === 'route_set') {
    const points = capPoints(sanitizePoints(body.points), 1200);
    if (points.length < 2) return NextResponse.json({ error: 'a route needs at least 2 points' }, { status: 400 });
    try {
      await writeRoute({ name: str(body.name, 80) || 'Planned route', points, ts: now });
      return NextResponse.json({ ok: true, points: points.length });
    } catch (e) {
      return NextResponse.json({ error: 'route write failed: ' + (e.message || e) }, { status: 500 });
    }
  }

  if (type === 'route_clear' || type === 'track_clear') {
    try {
      if (type === 'route_clear') await clearRoute();
      else await clearTracks(str(body.name, 40) || null);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: 'clear failed: ' + (e.message || e) }, { status: 500 });
    }
  }

  // wipes walker pins (optionally a single walker's); separate blobs, not shared state
  if (type === 'location_clear') {
    try {
      await clearLocations(str(body.name, 40) || null);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return NextResponse.json({ error: 'location clear failed: ' + (e.message || e) }, { status: 500 });
    }
  }

  try {
  const state = await readState();

  if (state.timer.finished && type !== 'timer_unfinish') {
    return NextResponse.json({ error: 'The walk is finished — the record is frozen forever. 🏁' }, { status: 409 });
  }

  switch (type) {
    case 'timer_start': {
      if (!state.timer.running) {
        state.timer.running = true;
        state.timer.lastStartTs = now;
        if (!state.timer.startedAt) state.timer.startedAt = now;
        addEvent(state, { kind: 'status', name: 'Timer', text: state.timer.accumMs ? 'The clock is running again ▶️' : 'THE SAUNTER HAS BEGUN 🥾' });
      }
      break;
    }
    case 'timer_stop': {
      if (state.timer.running) {
        state.timer.accumMs += now - state.timer.lastStartTs;
        state.timer.running = false;
        state.timer.lastStartTs = null;
        addEvent(state, { kind: 'status', name: 'Timer', text: 'Clock paused ⏸️' });
      }
      break;
    }
    case 'timer_finish': {
      if (state.timer.running) {
        state.timer.accumMs += now - state.timer.lastStartTs;
        state.timer.running = false;
        state.timer.lastStartTs = null;
      }
      // close out active walkers
      for (const w of state.walkers) {
        if (w.active) {
          w.totalMs += now - w.joinedAt;
          w.active = false;
        }
      }
      state.timer.finished = true;
      state.timer.finishedAt = now;
      addEvent(state, { kind: 'status', name: 'Timer', text: 'THE WALK IS COMPLETE. Status snapped forever. 🏁🎉' });
      break;
    }
    case 'timer_unfinish': {
      state.timer.finished = false;
      state.timer.finishedAt = null;
      addEvent(state, { kind: 'status', name: 'Timer', text: 'Walk un-finished (admin correction)' });
      break;
    }
    case 'timer_reset': {
      state.timer = { ...state.timer, running: false, accumMs: 0, lastStartTs: null, startedAt: null, finished: false, finishedAt: null };
      addEvent(state, { kind: 'status', name: 'Timer', text: 'Clock reset to 0:00 (false start — it never happened 🤫)' });
      break;
    }
    case 'set_miles': {
      const m = num(body.miles, 0, 500);
      if (m === null) return NextResponse.json({ error: 'bad miles' }, { status: 400 });
      state.miles = Math.round(m * 100) / 100;
      break;
    }
    case 'steps_add': {
      const total = num(body.total, 0, 10000000);
      if (total === null) return NextResponse.json({ error: 'bad steps' }, { status: 400 });
      state.steps.push({ ts: now, total: Math.round(total) });
      if (state.steps.length > 300) state.steps = state.steps.slice(-300);
      break;
    }
    case 'walker_add': {
      const name = str(body.name, 40);
      if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
      const existing = state.walkers.find((w) => w.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (!existing.active) {
          existing.active = true;
          existing.joinedAt = now;
          addEvent(state, { kind: 'status', name, text: `${name} re-joined the walk! 🎉` });
        }
      } else {
        state.walkers.push({ id: randomUUID(), name, active: true, joinedAt: now, totalMs: 0 });
        addEvent(state, { kind: 'status', name, text: `${name} joined the walk! 🎉` });
      }
      break;
    }
    case 'walker_leave': {
      const w = state.walkers.find((x) => x.id === body.id);
      if (w && w.active) {
        w.totalMs += now - w.joinedAt;
        w.active = false;
        addEvent(state, { kind: 'status', name: w.name, text: `${w.name} left the walk. Legend. 👏` });
      }
      break;
    }
    case 'walker_rejoin': {
      const w = state.walkers.find((x) => x.id === body.id);
      if (w && !w.active) {
        w.active = true;
        w.joinedAt = now;
        addEvent(state, { kind: 'status', name: w.name, text: `${w.name} re-joined the walk! 🔁` });
      }
      break;
    }
    case 'comment': {
      const name = str(body.name, 40) || 'Anonymous';
      const text = str(body.text, 400);
      if (!text) return NextResponse.json({ error: 'empty comment' }, { status: 400 });
      addEvent(state, { kind: 'comment', name, text, lat: coord(body.lat), lng: coord(body.lng) });
      break;
    }
    case 'emoji': {
      const name = str(body.name, 40) || 'Anonymous';
      const emoji = str(body.emoji, 8);
      if (!emoji) return NextResponse.json({ error: 'empty emoji' }, { status: 400 });
      addEvent(state, { kind: 'emoji', name, emoji, lat: coord(body.lat), lng: coord(body.lng) });
      break;
    }
    case 'photo': {
      const name = str(body.name, 40) || 'Anonymous';
      const photoUrl = str(body.photoUrl, 500);
      if (!photoUrl.startsWith('https://')) return NextResponse.json({ error: 'bad photo url' }, { status: 400 });
      addEvent(state, { kind: 'photo', name, text: str(body.text, 300), photoUrl, lat: coord(body.lat), lng: coord(body.lng) });
      break;
    }
    case 'donate': {
      const name = str(body.name, 40) || 'Anonymous';
      const amount = num(body.amount, 1, 100000);
      if (amount === null) return NextResponse.json({ error: 'bad amount' }, { status: 400 });
      state.donations.total = Math.round((state.donations.total + amount) * 100) / 100;
      addEvent(state, { kind: 'donation', name, amount, text: str(body.text, 200) });
      break;
    }
    case 'challenge_add': {
      const by = str(body.name, 40) || 'Anonymous';
      const text = str(body.text, 300);
      const amount = num(body.amount, 1, 100000);
      if (!text || amount === null) return NextResponse.json({ error: 'need text + amount' }, { status: 400 });
      const ch = { id: randomUUID(), ts: now, by, text, amount, done: false, doneTs: null };
      state.challenges.push(ch);
      addEvent(state, { kind: 'challenge', name: by, text: `New challenge: “${text}” for $${amount}`, amount });
      break;
    }
    case 'challenge_done': {
      const ch = state.challenges.find((c) => c.id === body.id);
      if (ch && !ch.done) {
        ch.done = true;
        ch.doneTs = now;
        state.donations.total = Math.round((state.donations.total + ch.amount) * 100) / 100;
        addEvent(state, { kind: 'challenge_done', name: ch.by, text: `Challenge completed: “${ch.text}” — $${ch.amount} unlocked! ✅`, amount: ch.amount });
      }
      break;
    }
    case 'config_set': {
      if (typeof body.donateUrl === 'string') state.config.donateUrl = str(body.donateUrl, 400);
      if (typeof body.mapsEmbed === 'string') state.config.mapsEmbed = str(body.mapsEmbed, 1200);
      const goal = num(body.goal, 1, 10000000);
      if (goal !== null) state.donations.goal = goal;
      break;
    }
    case 'event_delete': {
      state.events = state.events.filter((e) => e.id !== body.id);
      break;
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }

  await writeState(state);
  return NextResponse.json({ ok: true, state });
  } catch (e) {
    return NextResponse.json({ error: 'server error: ' + (e.message || e) }, { status: 500 });
  }
}
