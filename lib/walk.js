/* Ends the walk on its own once the goal is reached, so the final picture is
   whatever it looked like at 24 hours rather than whatever it looked like when
   somebody remembered to press Finish. */

export function elapsedMsOf(timer, now) {
  if (!timer) return 0;
  return timer.accumMs + (timer.running && timer.lastStartTs ? Math.max(0, now - timer.lastStartTs) : 0);
}

export function applyAutoFinish(state, now = Date.now()) {
  const t = state && state.timer;
  if (!t || t.finished || !t.startedAt) return false;

  const goalMs = (t.goalHours || 24) * 3600000;
  if (elapsedMsOf(t, now) < goalMs) return false;

  // land exactly on the goal — nobody wants a final time of 24h 03m because
  // that's when a poll happened to notice
  t.accumMs = goalMs;
  t.running = false;
  t.lastStartTs = null;
  t.finished = true;
  t.finishedAt = now;

  for (const w of state.walkers || []) {
    if (w.active) {
      w.totalMs += Math.max(0, now - w.joinedAt);
      w.active = false;
    }
  }

  state.events = state.events || [];
  state.events.push({
    id: globalThis.crypto.randomUUID(),
    ts: now,
    kind: 'status',
    name: 'Timer',
    text: `${t.goalHours || 24} HOURS. THE SAUNTER IS COMPLETE. 🏁🎉`,
  });
  if (state.events.length > 800) state.events = state.events.slice(-800);

  return true;
}

/* What a finished walk stops accepting. Everything absent from this list still
   works after the finish — the fundraiser especially, since money keeps coming
   in after the walking stops. */
export const FROZEN_WHEN_FINISHED = new Set([
  'timer_start',
  'timer_stop',
  'set_miles',
  'steps_add',
  'walker_add',
  'walker_leave',
  'walker_rejoin',
]);
