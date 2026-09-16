'use strict';

// Cowork adapter logic (NOTES.md, Phase 5: Cowork). Cowork fires no hooks, but each
// Cowork session writes an audit.jsonl as it runs; bin/zoo-cowork.js reads new lines
// and this file turns them into the zoo's ordinary hook events, so the reducer, the
// popover and the tray treat Cowork sessions like any other. Pure: no I/O.
//
// Only an entry's type, subtype, tool name and timestamp are ever read. Audit entries
// also carry full tool inputs (commands, file contents, client work); those are
// dropped when a line is parsed and never reach ~/.zoo.

const VENDOR = 'claude-cowork';
const CLIENT = 'cowork';

// Regular Cowork tasks only. Scheduled tasks (hidden by Safiyya's call) and the app's
// internal session kinds (agent, dispatch_child, radar, chat) all carry a sessionType.
function isShownSession(meta) {
  return Boolean(meta) && typeof meta.cliSessionId === 'string' && meta.cliSessionId !== '' && !meta.sessionType;
}

// The first folder the user picked for the task, if any.
function projectDir(meta) {
  const folders = Array.isArray(meta.userSelectedFolders) ? meta.userSelectedFolders : [];
  return folders.find((f) => typeof f === 'string' && f !== '') || null;
}

const str = (v) => (typeof v === 'string' ? v : null);

// Keeps only the fields the adapter uses; called on every parsed line.
function pickEntry(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    type: str(e.type),
    subtype: str(e.subtype),
    tool_name: str(e.tool_name),
    at: str(e._audit_timestamp) || str(e.timestamp),
  };
}

function isoOrNull(at) {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Advances a session over audit entries. state: { phase, pending, since }.
// A request makes it blocked until every request has a response (they pair in order
// by tool name); a result ends the turn; anything else during a turn is working.
function advance(state, entries) {
  let { phase = 'spawned', pending = 0, since = null } = state || {};
  const transitions = [];
  const to = (next, at, extra = {}) => {
    if (next === phase) return;
    phase = next;
    since = at;
    transitions.push({ phase: next, at, ...extra });
  };
  for (const e of entries) {
    if (!e) continue;
    const at = isoOrNull(e.at) || since;
    if (e.type === 'system' && e.subtype === 'permission_request') {
      pending += 1;
      to('blocked', at, { tool_name: e.tool_name });
    } else if (e.type === 'system' && e.subtype === 'permission_response') {
      pending = Math.max(0, pending - 1);
      if (pending === 0 && phase === 'blocked') to('working', at, { tool_name: e.tool_name, resumed: true });
    } else if (e.type === 'result') {
      pending = 0;
      to(e.subtype === 'success' ? 'done' : 'errored', at, { subtype: e.subtype });
    } else if (e.type === 'user' || e.type === 'assistant' || (e.type === 'system' && e.subtype === 'init')) {
      if (pending === 0 && phase !== 'working') to('working', at);
    }
  }
  return { state: { phase, pending, since }, transitions };
}

// Zoo envelopes for transitions. needsStart: the zoo has no file for this session yet.
function eventsFor(meta, transitions, { needsStart = false, now = new Date().toISOString() } = {}) {
  const dir = projectDir(meta);
  const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : null;
  const env = (event, ts, data = {}) => ({
    ts: ts || now,
    vendor: VENDOR,
    session_id: meta.cliSessionId,
    event,
    cwd: dir,
    project_dir: dir,
    client: CLIENT,
    client_pid: null,
    agent_id: null,
    agent_type: null,
    data: { adapter: 'cowork', ...(title ? { session_title: title } : {}), ...data },
  });
  const out = [];
  if (needsStart && transitions.length) out.push(env('SessionStart', transitions[0].at, { source: 'startup' }));
  for (const t of transitions) {
    if (t.phase === 'blocked') out.push(env('PermissionRequest', t.at, t.tool_name ? { tool_name: t.tool_name } : {}));
    else if (t.phase === 'working' && t.resumed) out.push(env('PostToolUse', t.at, t.tool_name ? { tool_name: t.tool_name } : {}));
    else if (t.phase === 'working') out.push(env('UserPromptSubmit', t.at));
    else if (t.phase === 'done') out.push(env('Stop', t.at));
    else if (t.phase === 'errored') {
      out.push(env('StopFailure', t.at, { error_type: t.subtype, error_message: `Cowork turn ended: ${t.subtype || 'error'}` }));
    }
  }
  return out;
}

function endEvent(sessionId, now) {
  return {
    ts: now, vendor: VENDOR, session_id: sessionId, event: 'SessionEnd', cwd: null, project_dir: null,
    client: CLIENT, client_pid: null, agent_id: null, agent_type: null, data: { adapter: 'cowork', reason: 'gone from the Claude app' },
  };
}

module.exports = { VENDOR, CLIENT, isShownSession, projectDir, pickEntry, advance, eventsFor, endEvent };
