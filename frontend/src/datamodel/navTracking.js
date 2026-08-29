// GUI usage tracking — client-side capture + batched transmission of navigation views.
// See docs/plans/done/gui-usage-nav-tracking.md.
//
// Two independent timers, deliberately not conflated:
//   • Dwell debounce (700ms, Decision 3) lives in ProcessProvider and decides *what becomes an
//     event* — recordNavView(coords) is only called once the URL has stayed put.
//   • Flush throttle (≤ 1 submission / 10s, Decision 7) lives here and decides *how often we hit
//     the network* — each POST carries an array of all events queued since the last flush.
//
// Fire-and-forget: a failed submission must never surface to the user or block navigation.

import { ABSOLUTE_API } from './api';

const FLUSH_INTERVAL_MS = 10_000;

let queue = [];
let lastFlush = 0;          // ms timestamp of the last submission
let trailingTimer = null;   // pending trailing-flush timer, if any

// Build the request body from the queue and clear it. Returns null when there is nothing to send
// (the empty-queue invariant: no flush path ever hits the network with an empty array).
function drainBody() {
  if (queue.length === 0) return null;
  const body = { views: queue };
  queue = [];
  return body;
}

// Post a drained body. Prefer sendBeacon (survives unload); fall back to fetch keepalive.
// sendBeacon sends no auth header — fine, the endpoint is optional-auth and stores no identity.
function send(body) {
  const url = ABSOLUTE_API + '/nav/view';
  const json = JSON.stringify(body);
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([json], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch (e) {
    // fall through to fetch
  }
  // Fire-and-forget; a failed flush drops the batch rather than retrying (acceptable for
  // aggregate stats). keepalive lets it complete across an unload.
  try {
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                 body: json, keepalive: true }).catch(() => {});
  } catch (e) {
    // swallow — never affect the UI
  }
}

// Flush now if there is anything queued (respects the empty-queue invariant).
function flushNow() {
  if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
  const body = drainBody();
  if (!body) return;
  lastFlush = Date.now();
  send(body);
}

// Record a dwelled navigation coordinate. Pushes onto the in-memory queue and schedules a flush:
// leading if the throttle window has elapsed, otherwise a single trailing flush for the remainder.
export function recordNavView(coords) {
  queue.push(coords);
  const elapsed = Date.now() - lastFlush;
  if (elapsed >= FLUSH_INTERVAL_MS) {
    flushNow();
  } else if (!trailingTimer) {
    trailingTimer = setTimeout(() => { trailingTimer = null; flushNow(); },
                               FLUSH_INTERVAL_MS - elapsed);
  }
}

// Unconditional flush on tab close / navigate-away so the trailing batch isn't lost. Bypasses the
// throttle but still honours the empty-queue invariant (flushNow returns early if nothing queued).
function installUnloadFlush() {
  if (typeof window === 'undefined') return;
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flushNow();
  };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', onHidden);
}

installUnloadFlush();
