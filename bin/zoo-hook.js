#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { reduce, applyStaleCheck, applyUnreadCheck } = require('../lib/reducer');
const { newSessionOptions: takenColoursFor } = require('../lib/colours');
const { pidAlive, parsePid, isClientGone } = require('../lib/liveness');
const permission = require('../lib/permission');
const {
  DEFAULT_CONFIG,
  mergeConfig,
  approveTimeoutSeconds,
  heartbeatSeconds,
  unreadAfterSeconds,
  lingerMaxSeconds,
} = require('../lib/config');

const ZOO_DIR = path.join(os.homedir(), '.zoo');
const SESSIONS_DIR = path.join(ZOO_DIR, 'sessions');
const ARCHIVE_DIR = path.join(ZOO_DIR, 'archive');
const REQUESTS_DIR = path.join(ZOO_DIR, 'requests');
const DECISIONS_DIR = path.join(ZOO_DIR, 'decisions');
const EVENTS_LOG = path.join(ZOO_DIR, 'events.jsonl');
const CONFIG_FILE = path.join(ZOO_DIR, 'config.json');
const HEARTBEAT_FILE = path.join(ZOO_DIR, 'viewer-heartbeat');

const POLL_INTERVAL_MS = 250;
const LINGER_POLL_MS = 2000;

// Clients where a person can see and answer Claude Code's own prompt. Anywhere
// else (claude -p, the SDK, or an unknown client) nobody can, and Claude Code
// denies the call once its hooks finish, so lingering would only stall it.
const INTERACTIVE_CLIENTS = new Set(['cli', 'claude-desktop', 'claude-vscode']);

// Events that mean a display-only request has since been answered in the terminal.
// Notification is deliberately absent: permission_prompt fires ~6s into the same prompt.
const CLEARS_DISPLAY_ONLY = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd']);

// Set while this process waits on the viewer, and then on the terminal, so a
// signal can clean up and record what happened.
let active = null;
let lingering = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function ensureLayout() {
  ensureDir(ZOO_DIR);
  ensureDir(SESSIONS_DIR);
  ensureDir(ARCHIVE_DIR);
  ensureDir(REQUESTS_DIR);
  ensureDir(DECISIONS_DIR);
  if (!fs.existsSync(CONFIG_FILE)) {
    atomicWriteJson(CONFIG_FILE, DEFAULT_CONFIG);
  }
}

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o700 });
  fs.chmodSync(tmp, 0o700);
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o700);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readConfig() {
  return mergeConfig(readJsonSafe(CONFIG_FILE));
}

function appendEvent(envelope) {
  fs.appendFileSync(EVENTS_LOG, JSON.stringify(envelope) + '\n', { mode: 0o700 });
  fs.chmodSync(EVENTS_LOG, 0o700);
}

const sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.json`);
const archiveFile = (id) => path.join(ARCHIVE_DIR, `${id}.json`);
const requestFile = (id) => path.join(REQUESTS_DIR, `${id}.json`);
const decisionFile = (id) => path.join(DECISIONS_DIR, `${id}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function unlinkQuiet(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone
  }
}

// Logs that the session's process exited without a SessionEnd, then archives it
// through the reducer like any other ending.
function closeGoneSession(session, filePath) {
  if (!fs.existsSync(filePath)) return; // another hook got there first
  const envelope = {
    ts: new Date().toISOString(),
    vendor: session.vendor || 'claude-code',
    session_id: session.session_id,
    event: 'ZooSessionGone',
    cwd: session.cwd || null,
    project_dir: session.project_dir || null,
    client: session.client || null,
    client_pid: session.client_pid,
    agent_id: null,
    agent_type: null,
    data: { reason: 'client process exited without SessionEnd' },
  };
  appendEvent(envelope);
  atomicWriteJson(archiveFile(session.session_id), reduce(session, envelope));
  unlinkQuiet(filePath);
}

// Catches every other session's file up on the things that happen without a hook
// event: its process exiting (-> archived), done -> unread, and anything -> stale.
function sweepSessions(config, now, skipId) {
  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return;
  }
  const unreadSeconds = unreadAfterSeconds(config);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (id === skipId) continue;
    const filePath = path.join(SESSIONS_DIR, entry);
    const session = readJsonSafe(filePath);
    if (!session) continue;
    if (isClientGone(session)) {
      closeGoneSession(session, filePath);
      continue;
    }
    const next = applyStaleCheck(applyUnreadCheck(session, now, unreadSeconds), now, config.stale_hours);
    if (next !== session) {
      atomicWriteJson(filePath, next);
    }
  }
}

// A request lives exactly as long as the hook that wrote it. The age cap is only
// a backstop for a hook that was killed outright.
function sweepRequests(config, nowMs, answeredSessionId) {
  const maxAgeMs = (approveTimeoutSeconds(config) + lingerMaxSeconds(config) + 60) * 1000;

  let requests = [];
  try {
    requests = fs.readdirSync(REQUESTS_DIR);
  } catch {
    // nothing to sweep
  }
  for (const entry of requests) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(REQUESTS_DIR, entry);
    const rec = readJsonSafe(file);
    const age = rec ? nowMs - Date.parse(rec.ts) : Infinity;
    const expired = !(age <= maxAgeMs);
    const orphaned = !rec || !pidAlive(rec.pid);
    const answered = rec && rec.mode === 'display_only' && rec.session_id === answeredSessionId;
    if (expired || orphaned || answered) unlinkQuiet(file);
  }

  // A decision is consumed within a poll; anything older is left over.
  const decisionMaxAgeMs = (approveTimeoutSeconds(config) + 30) * 1000;
  let decisions = [];
  try {
    decisions = fs.readdirSync(DECISIONS_DIR);
  } catch {
    // nothing to sweep
  }
  for (const entry of decisions) {
    const file = path.join(DECISIONS_DIR, entry);
    try {
      if (nowMs - fs.lstatSync(file).mtimeMs > decisionMaxAgeMs) unlinkQuiet(file);
    } catch {
      // raced with the hook that consumed it
    }
  }
}

function viewerAlive(config) {
  try {
    const { mtimeMs } = fs.statSync(HEARTBEAT_FILE);
    return permission.isHeartbeatFresh(mtimeMs, Date.now(), heartbeatSeconds(config));
  } catch {
    return false;
  }
}

function readDecision(requestId) {
  const file = decisionFile(requestId);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.uid !== process.getuid()) {
    return { invalid: 'decision file is not a regular file owned by this user' };
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { invalid: 'decision file is not valid JSON' };
  }
}

// For a session seen for the first time: the colours already taken by sessions the
// zoo is showing (lib/colours.js, shared with the Cowork poller).
function newSessionOptions(sessionId) {
  return takenColoursFor(SESSIONS_DIR, sessionId, readConfig());
}

function updateSession(envelope, override) {
  const file = sessionFile(envelope.session_id);
  const next = reduce(readJsonSafe(file), envelope, newSessionOptions(envelope.session_id));
  if (override) override(next);
  atomicWriteJson(file, next);
  return next;
}

function recordDecision(envelope, requestId, result) {
  const data = {
    request_id: requestId,
    tool_name: envelope.data.tool_name || null,
    outcome: result.outcome,
  };
  if (result.reason !== undefined) data.reason = result.reason;
  if (result.why !== undefined) data.why = result.why;

  const zooEnvelope = {
    ts: new Date().toISOString(),
    vendor: envelope.vendor,
    session_id: envelope.session_id,
    event: 'ZooDecision',
    cwd: envelope.cwd,
    project_dir: envelope.project_dir,
    client: envelope.client,
    client_pid: envelope.client_pid,
    agent_id: envelope.agent_id,
    agent_type: envelope.agent_type,
    data,
  };
  appendEvent(zooEnvelope);
  // Don't resurrect a session that ended (and was archived) while we waited.
  if (fs.existsSync(sessionFile(envelope.session_id))) {
    updateSession(zooEnvelope);
  }
}

function abandonActive(outcome) {
  if (!active) return;
  const { envelope, requestId } = active;
  active = null;
  unlinkQuiet(requestFile(requestId));
  unlinkQuiet(decisionFile(requestId));
  try {
    recordDecision(envelope, requestId, { outcome });
  } catch {
    // best effort while exiting
  }
}

function endLinger(outcome) {
  if (!lingering) return;
  const { envelope, requestId } = lingering;
  lingering = null;
  if (requestId) unlinkQuiet(requestFile(requestId));
  if (!outcome) return;
  try {
    recordDecision(envelope, requestId, { outcome });
  } catch {
    // best effort while exiting
  }
}

// Claude Code shows its own prompt alongside this hook and sends SIGTERM as soon
// as that prompt is answered anywhere. Staying alive, with nothing on stdout, is
// the only way the zoo learns that a prompt was answered in the terminal.
async function linger(envelope, requestId, config) {
  const maxSeconds = lingerMaxSeconds(config);
  if (!INTERACTIVE_CLIENTS.has(envelope.client) || maxSeconds <= 0) return null;
  lingering = { envelope, requestId };
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.min(LINGER_POLL_MS, Math.max(0, deadline - Date.now())));
    const session = readJsonSafe(sessionFile(envelope.session_id));
    const clientDied = envelope.client_pid && !pidAlive(envelope.client_pid);
    if (!session || session.state !== 'blocked' || clientDied) {
      // Another event moved the session on, or its process is gone (the next
      // sweep archives it). Either way there is nothing left to learn.
      endLinger(null);
      return null;
    }
  }
  // Leave before Claude Code's own timeout, whose kill would look like an answer.
  endLinger('gave_up');
  return null;
}

async function handlePermissionRequest(envelope, payload, config) {
  const requestId = crypto.randomUUID();
  const toolName = payload.tool_name || null;
  sweepRequests(config, Date.now(), null);

  // Only offer the prompt to the viewer when one is open.
  if (!viewerAlive(config)) {
    updateSession(envelope, (s) => { s.pending_request = null; });
    sweepSessions(config, new Date(envelope.ts), envelope.session_id);
    recordDecision(envelope, null, { outcome: 'no_viewer' });
    return linger(envelope, null, config);
  }

  const allowEnabled = permission.isAllowEnabled(toolName, config);
  const digest = permission.requestDigest(toolName, payload.tool_input);
  const record = {
    ...permission.buildRequestRecord(payload, { requestId, ts: envelope.ts, digest, allowEnabled }),
    pid: process.pid,
  };

  if (allowEnabled) active = { envelope, requestId };
  atomicWriteJson(requestFile(requestId), record);
  updateSession(envelope, (s) => { s.pending_request = allowEnabled ? requestId : null; });
  sweepSessions(config, new Date(envelope.ts), envelope.session_id);

  // Tools outside matcher_scope get a read-only card for as long as the terminal
  // prompt is up; the terminal is the only place to answer them.
  if (!allowEnabled) {
    recordDecision(envelope, requestId, { outcome: 'display_only' });
    return linger(envelope, requestId, config);
  }

  const waited = await permission.waitForDecision({
    readDecision: () => readDecision(requestId),
    isViewerAlive: () => viewerAlive(readConfig()),
    now: Date.now,
    sleep,
    timeoutMs: approveTimeoutSeconds(config) * 1000,
    intervalMs: POLL_INTERVAL_MS,
  });

  let result;
  if (waited.kind !== 'decision') {
    result = { outcome: waited.kind };
  } else if (waited.decision && waited.decision.invalid) {
    result = { outcome: 'rejected', why: waited.decision.invalid };
  } else {
    // Re-read config so disabling a tool mid-wait still takes effect.
    result = permission.validateDecision(waited.decision, { requestId, digest, toolName, config: readConfig() });
  }

  active = null;
  unlinkQuiet(requestFile(requestId));
  unlinkQuiet(decisionFile(requestId));
  recordDecision(envelope, requestId, result);

  const output = permission.formatHookOutput(result);
  if (output) return output;
  // defer, timeout, viewer gone or rejected: the terminal prompt is the only one now.
  return linger(envelope, null, config);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const ts = new Date().toISOString();
  const envelope = {
    ts,
    vendor: 'claude-code',
    session_id: payload.session_id || 'unknown',
    event: payload.hook_event_name || 'Unknown',
    cwd: payload.cwd || null,
    project_dir: process.env.CLAUDE_PROJECT_DIR || null,
    client: process.env.CLAUDE_CODE_ENTRYPOINT || null,
    client_pid: parsePid(process.env.CLAUDE_PID),
    agent_id: payload.agent_id || null,
    agent_type: payload.agent_type || null,
    data: payload,
  };

  ensureLayout();
  appendEvent(envelope);
  const config = readConfig();

  if (envelope.event === 'PermissionRequest') {
    return handlePermissionRequest(envelope, payload, config);
  }

  const existingPath = sessionFile(envelope.session_id);
  const nextSession = reduce(readJsonSafe(existingPath), envelope, newSessionOptions(envelope.session_id));

  if (envelope.event === 'SessionEnd') {
    atomicWriteJson(archiveFile(envelope.session_id), nextSession);
    unlinkQuiet(existingPath);
    sweepSessions(config, new Date(ts), null);
  } else {
    atomicWriteJson(existingPath, nextSession);
    sweepSessions(config, new Date(ts), envelope.session_id);
  }

  sweepRequests(config, Date.parse(ts), CLEARS_DISPLAY_ONLY.has(envelope.event) ? envelope.session_id : null);
  return null;
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    abandonActive('cancelled');
    endLinger('cancelled');
    process.exit(0);
  });
}

// stdout is the decision channel and must carry nothing else. On macOS, pipe
// writes are async, so exit only once the write has flushed.
main().then(
  (output) => {
    if (output) process.stdout.write(output, () => process.exit(0));
    else process.exit(0);
  },
  () => {
    abandonActive('error');
    endLinger(null);
    process.exit(0);
  },
);
