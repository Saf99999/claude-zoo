'use strict';

// Heartbeat for current Cowork tasks (NOTES.md, Phase 5: Cowork heartbeat monster).
// New Cowork tasks keep their activity inside the VM's encrypted disk image and write
// no audit log, but the Claude app's cowork_vm_node.log records every burst of Cowork
// activity: "[startVM] VM already connected" on each turn, chat-only turns included,
// and "[vmOneShot] Running: bash ... as rcw-<handle>" when a task runs a command.
//
// One monster for all of it: working while activity arrives, done after a quiet
// spell, gone after a long one. Per-task monsters keyed by handle were tried first and
// missed chat-only turns, which carry no handle (Safiyya's first live test). Two tasks
// running at once share the one monster. No title, no blocked, no real "finished" line.
// Pure: no I/O.

const DEFAULTS = Object.freeze({
  doneAfterMs: 2 * 60 * 1000, // quiet this long: done
  endAfterMs: 30 * 60 * 1000, // quiet this long: the monster leaves
});

// The one monster's key; the poller names its session cowork-<key>.
const KEY = 'live';

const LINE_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \[\w+\] \[(startVM|vmOneShot)\]/;
const HANDLE_RE = /\bas (rcw-[a-z0-9]{4,64})\b/;

// { at (ms, from the log's local time), handle (or null) }, or null for other lines.
function parseVmLine(line) {
  const m = LINE_RE.exec(String(line || ''));
  if (!m) return null;
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const h = m[7] === 'vmOneShot' ? HANDLE_RE.exec(line) : null;
  return { at, handle: h ? h[1] : null };
}

// state: { handles: { [KEY]: { last, phase } } } (the shape keeps room for more keys).
// Returns the new state and events { handle: KEY, event: start|working|done|end, at }.
function advanceHeartbeat(state, activity, nowMs, options = {}) {
  const { doneAfterMs, endAfterMs } = { ...DEFAULTS, ...options };
  const handles = { ...((state && state.handles) || {}) };
  const events = [];

  for (const a of activity) {
    if (!a || !Number.isFinite(a.at)) continue;
    const rec = handles[KEY];
    if (!rec) {
      handles[KEY] = { last: a.at, phase: 'working' };
      events.push({ handle: KEY, event: 'start', at: a.at });
    } else {
      if (rec.phase !== 'working') events.push({ handle: KEY, event: 'working', at: a.at });
      handles[KEY] = { last: Math.max(rec.last, a.at), phase: 'working' };
    }
  }

  const rec = handles[KEY];
  if (rec) {
    const quiet = nowMs - rec.last;
    if (quiet >= endAfterMs) {
      events.push({ handle: KEY, event: 'end', at: nowMs });
      delete handles[KEY];
    } else if (rec.phase === 'working' && quiet >= doneAfterMs) {
      handles[KEY] = { ...rec, phase: 'done' };
      events.push({ handle: KEY, event: 'done', at: nowMs });
    }
  }
  return { state: { handles }, events };
}

module.exports = { DEFAULTS, KEY, parseVmLine, advanceHeartbeat };
