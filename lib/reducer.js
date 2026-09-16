'use strict';

const crypto = require('crypto');
const path = require('path');

function monsterSeed(dir) {
  return crypto.createHash('sha1').update(dir || '').digest('hex');
}

function baseName(dir) {
  if (!dir) return 'unknown';
  return path.basename(dir);
}

// A session keeps the name and monster of the folder it started in, however often
// Claude changes directory. A title from the client (the desktop app sends one)
// wins for the name; the monster stays tied to the folder.
function displayName(title, projectDir) {
  return title || baseName(projectDir);
}

// The scarf monster's colorways (ui/monsters/scarf/SPEC.md). A session's colour is
// picked once, when the session is first seen, and kept for its life (PLAN.md,
// locked decision 6): at random from the colours no other live session holds, so
// sessions running at the same time look different, or from all four once they're
// all taken.
const COLORWAYS = Object.freeze(['teal', 'indigo', 'violet', 'rose']);

function pickColorway(taken, random = Math.random) {
  const free = COLORWAYS.filter((c) => !taken.includes(c));
  const pool = free.length ? free : COLORWAYS;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

// The colour a session shows: its own, or for sessions from before colorways were
// stored, the old derivation from monster_seed (first byte mod 4). ui/index.html and
// src-tauri/src/app.rs read colours the same way.
function colorwayOf(session) {
  if (session && COLORWAYS.includes(session.colorway)) return session.colorway;
  const byte = parseInt(String((session && session.monster_seed) || '').slice(0, 2), 16);
  return Number.isNaN(byte) ? 'teal' : COLORWAYS[byte % COLORWAYS.length];
}

// options.taken() lists the colours other live sessions hold; options.random is
// the random source. Both come from the caller (the hook), so reduce stays pure.
function newSession(envelope, { taken = () => [], random = Math.random } = {}) {
  const projectDir = envelope.project_dir || envelope.cwd || null;
  return {
    session_id: envelope.session_id,
    vendor: envelope.vendor,
    client: envelope.client || null,
    client_pid: envelope.client_pid || null,
    cwd: envelope.cwd,
    project_dir: projectDir,
    title: null,
    name: displayName(null, projectDir),
    monster_seed: monsterSeed(projectDir),
    colorway: pickColorway(taken(), random),
    state: 'spawned',
    since: envelope.ts,
    // When the current turn ended, and which ended turn the user has marked seen
    // in the viewer. A seen mark only counts while the two match.
    finished_at: null,
    seen_for: null,
    last_event: envelope.event,
    last_message: null,
    pending_request: null,
    children: {},
    permission_mode: envelope.data && envelope.data.permission_mode || null,
    updated_at: envelope.ts,
  };
}

// Pure function: (previousSession, envelope) -> nextSession
// previousSession may be null for a session the reducer has not seen before.
// options: see newSession. Only used when previousSession is null; a session's
// colorway is never recomputed afterwards, unlike monster_seed below.
function reduce(previousSession, envelope, options) {
  const session = previousSession
    ? { ...previousSession, children: { ...previousSession.children } }
    : newSession(envelope, options);
  const data = envelope.data || {};

  session.cwd = envelope.cwd || session.cwd;
  if (envelope.project_dir) {
    session.project_dir = envelope.project_dir;
  } else if (!session.project_dir || (envelope.event === 'SessionStart' && data.source !== 'compact')) {
    session.project_dir = envelope.cwd || session.project_dir || session.cwd;
  }
  if (typeof data.session_title === 'string' && data.session_title.trim()) {
    session.title = data.session_title.trim();
  }
  if (envelope.client) session.client = envelope.client;
  if (envelope.client_pid) session.client_pid = envelope.client_pid;
  session.name = displayName(session.title, session.project_dir);
  session.monster_seed = monsterSeed(session.project_dir);
  if (data.permission_mode) session.permission_mode = data.permission_mode;
  session.last_event = envelope.event;
  session.updated_at = envelope.ts;

  switch (envelope.event) {
    case 'SessionStart': {
      if (data.source === 'compact') {
        // Not a new session; state is untouched.
        break;
      }
      session.state = 'spawned';
      session.since = envelope.ts;
      session.finished_at = null;
      session.pending_request = null;
      break;
    }

    case 'UserPromptSubmit': {
      session.state = 'working';
      session.since = envelope.ts;
      session.finished_at = null;
      session.pending_request = null;
      break;
    }

    case 'PreToolUse':
    case 'PostToolUse': {
      if (envelope.agent_id) {
        session.children[envelope.agent_id] = {
          ...(session.children[envelope.agent_id] || {}),
          agent_type: envelope.agent_type || (session.children[envelope.agent_id] || {}).agent_type || null,
          state: 'working',
        };
        break;
      }
      if (session.state === 'blocked') {
        session.state = 'working';
        session.since = envelope.ts;
        session.pending_request = null;
      }
      break;
    }

    case 'PermissionRequest': {
      session.state = 'blocked';
      session.since = envelope.ts;
      session.pending_request = data.tool_use_id || null;
      break;
    }

    case 'Notification': {
      if (data.notification_type === 'permission_prompt') {
        if (session.state !== 'blocked') {
          session.state = 'blocked';
          session.since = envelope.ts;
        }
      } else if (data.notification_type === 'idle_prompt') {
        // A turn interrupted by a terminal No has no Stop; idle_prompt ends it.
        if (!session.finished_at) session.finished_at = envelope.ts;
        if (!isSeen(session)) {
          session.state = 'unread';
          session.since = envelope.ts;
        }
      }
      // agent_needs_input / agent_completed / anything else: logged only,
      // no state transition (last_event/updated_at already recorded above).
      break;
    }

    case 'Stop': {
      session.state = 'done';
      session.since = envelope.ts;
      session.finished_at = envelope.ts;
      if (typeof data.last_assistant_message === 'string') {
        session.last_message = data.last_assistant_message.slice(0, 200);
      }
      session.pending_request = null;
      break;
    }

    case 'StopFailure': {
      session.state = 'errored';
      session.since = envelope.ts;
      session.last_message = data.error_message || null;
      session.pending_request = null;
      break;
    }

    case 'SubagentStop': {
      if (envelope.agent_id) {
        session.children[envelope.agent_id] = {
          agent_type: envelope.agent_type || null,
          state: 'done',
          last_message: typeof data.last_assistant_message === 'string'
            ? data.last_assistant_message.slice(0, 200)
            : null,
        };
      }
      break;
    }

    // ZooSessionGone is the zoo's own record that the session's process exited
    // without a SessionEnd reaching it.
    case 'SessionEnd':
    case 'ZooSessionGone': {
      session.state = 'gone';
      session.since = envelope.ts;
      session.pending_request = null;
      break;
    }

    case 'ZooDecision': {
      // allow/deny resolve the prompt from the viewer. cancelled means Claude Code
      // killed the hook because the prompt was answered in the terminal, so it's
      // resolved too. defer/timeout/rejected hand the prompt back to the terminal,
      // still unanswered.
      const resolved = ['allow', 'deny', 'cancelled'].includes(data.outcome);
      if (resolved && session.state === 'blocked') {
        session.state = 'working';
        session.since = envelope.ts;
      }
      if (!data.request_id || session.pending_request === data.request_id) {
        session.pending_request = null;
      }
      break;
    }

    case 'ZooSeen': {
      // The user clicked a finished monster in the viewer: they've seen this turn.
      if (data.finished_at && data.finished_at === session.finished_at
          && (session.state === 'done' || session.state === 'unread')) {
        session.seen_for = session.finished_at;
        if (session.state === 'unread') {
          session.state = 'done';
          session.since = envelope.ts;
        }
      }
      break;
    }

    default:
      // Unknown event: still recorded via last_event/updated_at above.
      break;
  }

  return session;
}

function isSeen(session) {
  return Boolean(session.finished_at) && session.seen_for === session.finished_at;
}

// The viewer's seen mark lives in its own file, since only hooks write session
// files. Applied at read time: a matching mark makes an unread session done again
// and keeps it from going unread. A mark for an earlier turn does nothing.
function applySeen(session, mark) {
  if (!mark || !session.finished_at || mark.finished_at !== session.finished_at) return session;
  return { ...session, seen_for: session.finished_at, state: session.state === 'unread' ? 'done' : session.state };
}

// Applies the stale check to a single session file's derived state.
// now: Date, staleHours: number. Returns the (possibly mutated) session.
function applyStaleCheck(session, now, staleHours) {
  if (session.state === 'gone' || session.state === 'stale') return session;
  const updatedAt = new Date(session.updated_at).getTime();
  if (Number.isNaN(updatedAt)) return session;
  const ageHours = (now.getTime() - updatedAt) / (1000 * 60 * 60);
  if (ageHours > staleHours) {
    return { ...session, state: 'stale', stale_from: session.state, since: now.toISOString() };
  }
  return session;
}

// A session opened and never given a prompt (clicked into, then left) is noise
// after a while: the viewer stops showing it until a prompt makes it working. That
// holds after it goes stale too, so it doesn't come back as a sleeping monster.
function isForgottenSpawn(session, now, hideMinutes) {
  if (!hideMinutes) return false;
  if (session.state === 'stale') return session.stale_from === 'spawned';
  if (session.state !== 'spawned') return false;
  const since = Date.parse(session.since);
  return !Number.isNaN(since) && now.getTime() - since > hideMinutes * 60 * 1000;
}

// A session done for unreadSeconds with no new prompt becomes unread, dated from
// the moment it crossed that line, unless the user has marked it seen. Returns the same object when nothing changes.
function applyUnreadCheck(session, now, unreadSeconds) {
  if (session.state !== 'done' || isSeen(session)) return session;
  const since = Date.parse(session.since);
  if (Number.isNaN(since)) return session;
  const dueAt = since + unreadSeconds * 1000;
  if (now.getTime() < dueAt) return session;
  return { ...session, state: 'unread', since: new Date(dueAt).toISOString() };
}

module.exports = {
  reduce, applyStaleCheck, applyUnreadCheck, applySeen, isSeen, isForgottenSpawn, monsterSeed, baseName, displayName,
  COLORWAYS, pickColorway, colorwayOf,
};
