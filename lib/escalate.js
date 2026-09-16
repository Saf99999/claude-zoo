'use strict';

// Hermes escalation (PLAN.md, Phase 5): when a session has been blocked a while and
// nobody is at the Mac, hand a one-line notice to Hermes, which messages Safiyya.
// The zoo never sends anything itself. This file is the pure part: which blocked
// periods are due. Reading ~/.zoo, the idle clock and the hand-off live in
// bin/zoo-escalate.js.

// A blocked period is identified by its session and when it started. One notice per
// period: a session that stays blocked isn't chased again, and a new block (a new
// `since`) can escalate afresh.
function periodKey(session) {
  return `${session.session_id}@${session.since}`;
}

// sessions: as the viewer sees them (time-based states derived, dead ones dropped).
// sent: Set of period keys already escalated. Returns the sessions due now, oldest
// block first.
function dueEscalations(sessions, { nowMs, idleSeconds, escalateMinutes, idleMinutes, sent }) {
  if (!(escalateMinutes > 0)) return [];
  if (!(idleSeconds >= idleMinutes * 60)) return [];
  return sessions
    .filter((s) => s && s.state === 'blocked')
    .filter((s) => {
      const since = Date.parse(s.since);
      return !Number.isNaN(since) && nowMs - since >= escalateMinutes * 60 * 1000;
    })
    .filter((s) => !sent.has(periodKey(s)))
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

// The notice itself. It travels through Photon's cloud to reach iMessage, so it
// carries only the session's folder, how long it has waited and the tool it wants
// (Safiyya's call, 2026-09-11): never the chat title, which can name client work,
// and never the command or file contents.
function noticeText(session, { nowMs, toolName }) {
  const minutes = Math.floor((nowMs - Date.parse(session.since)) / 60000);
  const dir = session.project_dir || session.cwd;
  const folder = dir ? String(dir).split('/').filter(Boolean).pop() : null;
  const where = folder ? ` in ${folder}` : '';
  const what = toolName ? ` to use ${toolName}` : '';
  return `zoo: a session${where} has been waiting ${minutes} min for your permission${what}.`;
}

module.exports = { periodKey, dueEscalations, noticeText };
