#!/usr/bin/env node
'use strict';

// Cowork poller (NOTES.md, Phase 5: Cowork). Cowork sessions fire no hooks, so this
// reads the audit.jsonl each Cowork session writes in the Claude app's data folder
// and feeds the zoo the same events a hook would, through the same reducer. Kept
// alive by launchd/com.example.zoo-cowork.plist (a template: copy and edit it for
// your own machine); reads only the new part of
// each file, every POLL_MS.
//
// Scheduled tasks are hidden. Sessions with no activity for stale_hours when first
// seen are tracked silently and appear once they're active again. What the zoo keeps
// of a Cowork session: its title, first folder, phase, times and tool names. Never
// tool inputs, prompts or replies (lib/cowork.js pickEntry).
//
// Current Cowork tasks no longer write audit logs, so this also follows the Claude
// app's cowork_vm_node.log for a heartbeat: one "Cowork" monster for all Cowork
// activity, working while it arrives, done after quiet (lib/cowork-heartbeat.js).
//
//   node bin/zoo-cowork.js          poll forever, as launchd runs it
//   node bin/zoo-cowork.js --once   one pass

const fs = require('fs');
const path = require('path');
const os = require('os');
const { reduce } = require('../lib/reducer');
const { mergeConfig } = require('../lib/config');
const { newSessionOptions } = require('../lib/colours');
const { VENDOR, isShownSession, pickEntry, advance, eventsFor, endEvent } = require('../lib/cowork');
const { DEFAULTS: HEARTBEAT, parseVmLine, advanceHeartbeat } = require('../lib/cowork-heartbeat');

const POLL_MS = 2000;
// Read at most this much of a log per pass; the rest comes on later passes.
const MAX_READ_BYTES = 4 * 1024 * 1024;

function paths(home) {
  const zoo = path.join(home, '.zoo');
  return {
    zoo,
    sessions: path.join(zoo, 'sessions'),
    archive: path.join(zoo, 'archive'),
    events: path.join(zoo, 'events.jsonl'),
    state: path.join(zoo, 'cowork.json'),
    config: path.join(zoo, 'config.json'),
    store: path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    vmLog: path.join(home, 'Library', 'Logs', 'Claude', 'cowork_vm_node.log'),
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o700 });
  fs.renameSync(tmp, file);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// Every Cowork session in the store: <account>/<org>/local_<id>.json, with its audit
// log at <account>/<org>/local_<id>/audit.jsonl.
function listStore(store) {
  const dirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  };
  const out = [];
  for (const org of dirs(store).flatMap(dirs)) {
    let names;
    try {
      names = fs.readdirSync(org);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^local_[A-Za-z0-9-]{1,64}\.json$/.test(name)) continue;
      const localId = name.slice(0, -'.json'.length);
      out.push({ localId, metaPath: path.join(org, name), auditPath: path.join(org, localId, 'audit.jsonl') });
    }
  }
  return out;
}

// New complete lines since offset. A line still being written stays for the next
// pass. A shorter file means it was replaced.
function readRawLines(file, offset) {
  const st = statOrNull(file);
  if (!st) return { lines: [], offset, reset: false };
  let reset = false;
  if (st.size < offset) {
    offset = 0;
    reset = true;
  }
  if (st.size === offset) return { lines: [], offset, reset };
  const length = Math.min(st.size - offset, MAX_READ_BYTES);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // A single line longer than a whole read (a huge tool input): skip past it.
    return { lines: [], offset: length === MAX_READ_BYTES ? offset + length : offset, reset };
  }
  const lines = buf.subarray(0, lastNewline).toString('utf8').split('\n').filter(Boolean);
  return { lines, offset: offset + lastNewline + 1, reset };
}

// Audit log lines reduced to the fields the adapter reads.
function readNew(auditPath, offset) {
  const { lines, offset: next, reset } = readRawLines(auditPath, offset);
  const entries = [];
  for (const line of lines) {
    try {
      const picked = pickEntry(JSON.parse(line));
      if (picked) entries.push(picked);
    } catch {
      // a malformed line is skipped, like any other entry the adapter doesn't use
    }
  }
  return { entries, offset: next, reset };
}

function heartbeatEnvelopes(handle, event, at, needsStart) {
  const env = (name, data = {}) => ({
    ts: new Date(at).toISOString(),
    vendor: VENDOR,
    session_id: `cowork-${handle}`,
    event: name,
    cwd: null,
    project_dir: null,
    client: 'cowork-heartbeat',
    client_pid: null,
    agent_id: null,
    agent_type: null,
    data: { adapter: 'cowork-heartbeat', session_title: 'Cowork', ...data },
  });
  const out = [];
  if (needsStart && event !== 'end') out.push(env('SessionStart', { source: 'startup' }));
  if (event === 'start' || event === 'working') out.push(env('UserPromptSubmit'));
  if (event === 'done') out.push(env('Stop'));
  if (event === 'end') out.push(env('SessionEnd', { reason: 'no Cowork activity' }));
  return out;
}

function heartbeatOptions(config) {
  const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
  return {
    doneAfterMs: positive(config.cowork_done_after_seconds, HEARTBEAT.doneAfterMs / 1000) * 1000,
    endAfterMs: positive(config.cowork_end_after_minutes, HEARTBEAT.endAfterMs / 60000) * 60000,
  };
}

function applyEvent(p, envelope, config) {
  fs.appendFileSync(p.events, JSON.stringify(envelope) + '\n', { mode: 0o700 });
  const file = path.join(p.sessions, `${envelope.session_id}.json`);
  const next = reduce(readJsonSafe(file), envelope, newSessionOptions(p.sessions, envelope.session_id, config));
  if (envelope.event === 'SessionEnd') {
    atomicWriteJson(path.join(p.archive, `${envelope.session_id}.json`), next);
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  } else {
    atomicWriteJson(file, next);
  }
}

// Only the metadata fields the poller uses; the files also hold system prompts and
// settings, which shouldn't sit in memory.
function slimMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const { cliSessionId, sessionType, isArchived, title, userSelectedFolders } = meta;
  return { cliSessionId, sessionType, isArchived, title, userSelectedFolders };
}

// One pass. metaCache (path -> {mtimeMs, meta}) persists across passes in the loop.
function run({ home = os.homedir(), now = new Date(), metaCache = new Map() } = {}) {
  const p = paths(home);
  if (!statOrNull(p.store)) return { skipped: 'no Cowork data' };
  for (const dir of [p.zoo, p.sessions, p.archive]) ensureDir(dir);
  const config = mergeConfig(readJsonSafe(p.config));
  const staleMs = (Number(config.stale_hours) > 0 ? Number(config.stale_hours) : 6) * 3600 * 1000;
  const nowIso = now.toISOString();
  const record = readJsonSafe(p.state) || {};
  const sessions = record.sessions && typeof record.sessions === 'object' ? record.sessions : {};
  let changed = false;
  let applied = 0;
  const listed = new Set();

  for (const { localId, metaPath, auditPath } of listStore(p.store)) {
    listed.add(localId);
    const metaStat = statOrNull(metaPath);
    if (!metaStat) continue;
    let cached = metaCache.get(metaPath);
    if (!cached || cached.mtimeMs !== metaStat.mtimeMs) {
      cached = { mtimeMs: metaStat.mtimeMs, meta: slimMeta(readJsonSafe(metaPath)) };
      metaCache.set(metaPath, cached);
    }
    const meta = cached.meta;
    if (!isShownSession(meta)) continue;
    const sid = meta.cliSessionId;
    const sessionFile = path.join(p.sessions, `${sid}.json`);
    let rec = sessions[localId];

    if (meta.isArchived) {
      if (rec && !rec.archived) {
        if (statOrNull(sessionFile)) {
          applyEvent(p, endEvent(sid, nowIso), config);
          applied += 1;
        }
        sessions[localId] = { ...rec, archived: true };
        changed = true;
      }
      continue;
    }

    const auditStat = statOrNull(auditPath);
    const firstSight = !rec;
    // Quiet for stale_hours: start at the end of its log without reading it, as a
    // finished task, and show nothing until it moves again.
    if (firstSight && (!auditStat || now.getTime() - auditStat.mtimeMs > staleMs)) {
      sessions[localId] = { sid, offset: auditStat ? auditStat.size : 0, phase: 'done', pending: 0, since: null, archived: false };
      changed = true;
      continue;
    }
    if (!rec) rec = { sid, offset: 0, phase: 'spawned', pending: 0, since: null, archived: false };
    if (rec.archived) rec = { ...rec, archived: false };

    const { entries, offset, reset } = readNew(auditPath, rec.offset);
    if (!entries.length && !reset && !firstSight) continue;
    const { state, transitions } = advance(reset ? {} : rec, entries);
    sessions[localId] = { ...rec, ...state, sid, offset };
    changed = true;
    if (!transitions.length) continue;

    // Seen for the first time (or its log was replaced): only where it stands now.
    const emit = firstSight || reset
      ? transitions.slice(-1).map((t) => ({ ...t, resumed: false }))
      : transitions;
    for (const envelope of eventsFor(meta, emit, { needsStart: !statOrNull(sessionFile), now: nowIso })) {
      applyEvent(p, envelope, config);
      applied += 1;
    }
  }

  // Deleted from the Claude app: end it in the zoo too.
  for (const [localId, rec] of Object.entries(sessions)) {
    if (listed.has(localId)) continue;
    if (rec && rec.sid && statOrNull(path.join(p.sessions, `${rec.sid}.json`))) {
      applyEvent(p, endEvent(rec.sid, nowIso), config);
      applied += 1;
    }
    delete sessions[localId];
    changed = true;
  }

  // Heartbeat from the VM log. The first time, and after the log is replaced, start at
  // its end: history isn't replayed as a flood of monsters.
  const heartbeat = record.heartbeat && typeof record.heartbeat === 'object' ? { ...record.heartbeat } : {};
  const vmStat = statOrNull(p.vmLog);
  let activity = [];
  if (vmStat) {
    if (typeof heartbeat.offset !== 'number' || vmStat.size < heartbeat.offset) {
      heartbeat.offset = vmStat.size;
      changed = true;
    } else if (vmStat.size > heartbeat.offset) {
      const read = readRawLines(p.vmLog, heartbeat.offset);
      heartbeat.offset = read.offset;
      activity = read.lines.map(parseVmLine).filter(Boolean);
      changed = true;
    }
  }
  const before = JSON.stringify(heartbeat.state || null);
  const { state: hbState, events: hbEvents } = advanceHeartbeat(heartbeat.state, activity, now.getTime(), heartbeatOptions(config));
  heartbeat.state = hbState;
  if (JSON.stringify(hbState) !== before) changed = true;
  for (const { handle, event, at } of hbEvents) {
    const exists = Boolean(statOrNull(path.join(p.sessions, `cowork-${handle}.json`)));
    if (event === 'end' && !exists) continue;
    for (const envelope of heartbeatEnvelopes(handle, event, at, !exists)) {
      applyEvent(p, envelope, config);
      applied += 1;
    }
  }

  if (changed) atomicWriteJson(p.state, { sessions, heartbeat });
  return { applied };
}

function main() {
  if (process.argv.includes('--once')) {
    console.log(JSON.stringify(run()));
    return;
  }
  const metaCache = new Map();
  const tick = () => {
    try {
      run({ now: new Date(), metaCache });
    } catch (err) {
      console.error(`zoo-cowork: ${err && err.stack ? err.stack : err}`);
    }
    setTimeout(tick, POLL_MS);
  };
  tick();
}

if (require.main === module) main();

module.exports = { run, readNew, readRawLines, listStore, POLL_MS };
