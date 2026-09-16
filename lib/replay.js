'use strict';

const { reduce, isSeen } = require('./reducer');

const ATTENTION = new Set(['blocked', 'errored', 'unread']);
const LONG_BLOCK_MS = 2 * 60 * 1000;

function formatDuration(ms) {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// A finished background task re-enters the session as a UserPromptSubmit whose
// "prompt" is a <task-notification>. It looks like typing, but it isn't the user.
function isBackgroundTurn(env) {
  const prompt = env.data && env.data.prompt;
  return env.event === 'UserPromptSubmit' && typeof prompt === 'string'
    && prompt.trimStart().startsWith('<task-notification>');
}

// Content-free label for what caused a transition: never includes prompt text.
function describe(env) {
  const data = env.data || {};
  if (env.event === 'Notification' && data.notification_type) return `Notification(${data.notification_type})`;
  if (env.event === 'ZooDecision' && data.outcome) return `ZooDecision(${data.outcome})`;
  if (env.event === 'SessionStart' && data.source) return `SessionStart(${data.source})`;
  if (isBackgroundTurn(env)) return 'UserPromptSubmit(background task)';
  return env.event;
}

function isValid(env) {
  return env && typeof env === 'object' && typeof env.session_id === 'string'
    && typeof env.event === 'string' && !Number.isNaN(Date.parse(env.ts));
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.name} ${item.state}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Mirrors applyUnreadCheck between events: a done interval longer than the
// unread delay becomes done-then-unread, and a seen mark (seenAt) either stops
// that or, if it came later, ends the unread. Adjacent same-state intervals
// merge, so a derived unread followed by idle_prompt's unread reads as one period.
function deriveUnread(intervals, unreadAfterMs) {
  const label = `no prompt for ${formatDuration(unreadAfterMs)}`;
  const split = [];
  for (const iv of intervals) {
    const at = iv.start + unreadAfterMs;
    if (iv.state === 'done' && iv.end - iv.start > unreadAfterMs && iv.seenAt !== undefined) {
      if (iv.seenAt <= at) {
        split.push(iv);
      } else {
        split.push({ ...iv, end: at, endedBy: label, open: false });
        split.push({ state: 'unread', start: at, end: iv.seenAt, startedBy: label, endedBy: 'ZooSeen', open: false });
        split.push({ ...iv, start: iv.seenAt, startedBy: 'ZooSeen' });
      }
    } else if (iv.state === 'done' && iv.end - iv.start > unreadAfterMs) {
      split.push({ ...iv, end: at, endedBy: label, open: false });
      split.push({ state: 'unread', start: at, end: iv.end, startedBy: label, endedBy: iv.endedBy, open: iv.open });
    } else {
      split.push(iv);
    }
  }
  const merged = [];
  for (const iv of split) {
    const prev = merged[merged.length - 1];
    if (prev && prev.state === iv.state) {
      prev.end = iv.end;
      prev.endedBy = iv.endedBy;
      prev.open = iv.open;
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

// Replays envelopes through the current reducer and returns each session's state
// intervals plus flags for the state-model review. Pure: no I/O.
function replay(envelopes, { unreadAfterMs = 60 * 1000 } = {}) {
  const events = envelopes
    .filter(isValid)
    .map((env, i) => ({ env, i, t: Date.parse(env.ts) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  if (!events.length) return { start: null, end: null, events: 0, sessions: [], duplicates: [] };

  const sessions = new Map();
  for (const { env, t } of events) {
    let rec = sessions.get(env.session_id);
    if (!rec) {
      rec = {
        id: env.session_id,
        first: t,
        names: [],
        current: null,
        intervals: [],
        events: 0,
        backgroundTurns: 0,
        unlabelledSubagentStops: 0,
        flags: [],
      };
      sessions.set(env.session_id, rec);
    }
    rec.events += 1;
    if (isBackgroundTurn(env)) rec.backgroundTurns += 1;
    if (env.event === 'SubagentStop' && !env.agent_type) rec.unlabelledSubagentStops += 1;

    const before = rec.current ? rec.current.state : null;
    const next = reduce(rec.current, env);
    if (rec.names[rec.names.length - 1] !== next.name) rec.names.push(next.name);
    if (next.state !== before) {
      const open = rec.intervals[rec.intervals.length - 1];
      if (open) {
        open.end = t;
        open.endedBy = describe(env);
      }
      rec.intervals.push({ state: next.state, start: t, end: null, startedBy: describe(env), endedBy: null, open: false });
    }
    const current = rec.intervals[rec.intervals.length - 1];
    if (current && current.state === 'done' && current.seenAt === undefined && isSeen(next)) current.seenAt = t;
    rec.current = next;
  }

  const start = events[0].t;
  const end = events[events.length - 1].t;
  const list = [...sessions.values()].sort((a, b) => a.first - b.first);
  for (const rec of list) {
    const last = rec.intervals[rec.intervals.length - 1];
    if (last && last.end === null) {
      last.end = end;
      last.open = true;
    }
    rec.intervals = deriveUnread(rec.intervals, unreadAfterMs);
  }

  for (const rec of list) {
    for (const iv of rec.intervals) {
      if (iv.state !== 'blocked') continue;
      const reasons = [];
      if (iv.endedBy === 'UserPromptSubmit') reasons.push('ended by a new prompt, so it had already been answered');
      if (iv.end - iv.start > LONG_BLOCK_MS) reasons.push(`lasted ${formatDuration(iv.end - iv.start)}`);
      if (iv.open) reasons.push('still blocked when the log ends');
      if (!reasons.length) continue;
      const alsoWaiting = list
        .filter((other) => other !== rec)
        .flatMap((other) => other.intervals
          .filter((o) => ATTENTION.has(o.state) && overlaps(o, iv))
          .map((o) => ({ name: other.names[other.names.length - 1], state: o.state })));
      rec.flags.push({ start: iv.start, end: iv.end, reasons, alsoWaiting: dedupe(alsoWaiting) });
    }
  }

  const duplicates = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const nameA = a.names[a.names.length - 1];
      if (nameA !== b.names[b.names.length - 1]) continue;
      const lifeA = { start: a.first, end: a.intervals[a.intervals.length - 1].end };
      const lifeB = { start: b.first, end: b.intervals[b.intervals.length - 1].end };
      if (overlaps(lifeA, lifeB) && !duplicates.includes(nameA)) duplicates.push(nameA);
    }
  }

  return {
    start,
    end,
    events: events.length,
    sessions: list.map(({ current, ...rest }) => rest),
    duplicates,
  };
}

module.exports = { replay, formatDuration, isBackgroundTurn, LONG_BLOCK_MS };
