#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { requestDigest, isAllowEnabled, MAX_REASON_LENGTH } = require('../lib/permission');
const { applyStaleCheck, applyUnreadCheck, applySeen, isForgottenSpawn } = require('../lib/reducer');
const { pidAlive, isClientGone } = require('../lib/liveness');
const { mergeConfig, approveTimeoutSeconds, unreadAfterSeconds, spawnedHideMinutes } = require('../lib/config');
const { planJump, performJump } = require('../lib/jump');

const ZOO_DIR = path.join(os.homedir(), '.zoo');
const SESSIONS_DIR = path.join(ZOO_DIR, 'sessions');
const REQUESTS_DIR = path.join(ZOO_DIR, 'requests');
const DECISIONS_DIR = path.join(ZOO_DIR, 'decisions');
const SEEN_DIR = path.join(ZOO_DIR, 'seen');
const EVENTS_LOG = path.join(ZOO_DIR, 'events.jsonl');
const CONFIG_FILE = path.join(ZOO_DIR, 'config.json');
const HEARTBEAT_FILE = path.join(ZOO_DIR, 'viewer-heartbeat');
const INDEX_HTML = path.join(__dirname, '..', 'ui', 'index.html');
const MONSTERS_DIR = path.join(__dirname, '..', 'ui', 'monsters');
// Monster art is loaded by <img>, which can't send the token header, and it isn't
// secret, so pose images (optionally with a _colorway suffix) are served without
// one. The pattern admits no dots or slashes of its own, so nothing else under ui/
// is reachable through it.
const MONSTER_ART_RE = /^\/monsters\/([a-z0-9-]+)\/((?:standing|working|blocked|dancing|errored|sleeping)(?:_[a-z]+)?)\.png$/;
const PORT = Number(process.env.ZOO_PORT) || 4790;

// Per-process secret, embedded in the page we serve. Every API call must echo
// it in a custom header, which a cross-origin page can neither read nor send
// (a custom header forces a CORS preflight this server never answers).
const TOKEN = crypto.randomBytes(32).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY_BYTES = 16 * 1024;
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

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

function permissionProblem(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return `${dir} does not exist`;
  }
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (st.uid !== process.getuid()) return `${dir} is owned by uid ${st.uid}, not you (uid ${process.getuid()})`;
  const mode = st.mode & 0o777;
  if (mode !== 0o700) return `${dir} has mode ${mode.toString(8).padStart(3, '0')}, expected 700`;
  return null;
}

function securityProblem() {
  return permissionProblem(ZOO_DIR) || permissionProblem(REQUESTS_DIR) || permissionProblem(DECISIONS_DIR);
}

function tokenMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Time-based states are also derived here, so a finished session turns unread on
// screen even when no hook has fired since, and a session whose process has exited
// disappears at once rather than waiting for the next hook to archive it. Sessions
// opened and never prompted drop out after spawned_hide_minutes.
function readSessions(config) {
  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const now = new Date();
  const unreadSeconds = unreadAfterSeconds(config);
  const hideMinutes = spawnedHideMinutes(config);
  const sessions = [];
  for (const entry of entries) {
    const s = readJsonSafe(path.join(SESSIONS_DIR, entry));
    if (!s || isClientGone(s) || isForgottenSpawn(s, now, hideMinutes)) continue;
    const seen = applySeen(s, readJsonSafe(path.join(SEEN_DIR, entry)));
    sessions.push(applyStaleCheck(applyUnreadCheck(seen, now, unreadSeconds), now, config.stale_hours));
  }
  return sessions;
}

// Only requests whose hook is still alive and whose content is untampered reach
// the page. A request lives exactly as long as the hook that wrote it.
function readRequests(config) {
  let entries;
  try {
    entries = fs.readdirSync(REQUESTS_DIR);
  } catch {
    return [];
  }
  const timeoutMs = approveTimeoutSeconds(config) * 1000;
  const out = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!REQUEST_ID_RE.test(id)) continue;
    const rec = readJsonSafe(path.join(REQUESTS_DIR, entry));
    if (!rec || rec.request_id !== id) continue;
    if (rec.digest !== requestDigest(rec.tool_name, rec.tool_input)) continue;
    if (!pidAlive(rec.pid)) continue;
    out.push({
      ...rec,
      allow_enabled: rec.mode === 'awaiting' && isAllowEnabled(rec.tool_name, config),
      expires_at: new Date(Date.parse(rec.ts) + timeoutMs).toISOString(),
    });
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

function touchHeartbeat() {
  fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), { mode: 0o700 });
}

// Create-exclusive: the first decision for a request wins, a second click can't overwrite it.
function writeDecisionExclusive(file, decision) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(decision), { mode: 0o700 });
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function send(res, status, body, extraHeaders = {}) {
  const isString = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isString ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(isString ? body : JSON.stringify(body));
}

function readBody(req, callback) {
  const chunks = [];
  let size = 0;
  let finished = false;
  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      finished = true;
      callback(new Error('body too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    callback(null, Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', (err) => {
    if (finished) return;
    finished = true;
    callback(err);
  });
}

function decide(body) {
  const problem = securityProblem();
  if (problem) return [500, { error: `refusing to write decisions: ${problem}` }];

  const { request_id: requestId, behavior, digest } = body || {};
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return [400, { error: 'bad request_id' }];
  if (!['allow', 'deny', 'defer'].includes(behavior)) return [400, { error: 'bad behavior' }];

  const rec = readJsonSafe(path.join(REQUESTS_DIR, `${requestId}.json`));
  if (!rec || rec.request_id !== requestId || rec.mode !== 'awaiting' || !pidAlive(rec.pid)) {
    return [409, { error: 'that request has already closed (answered, timed out, or cancelled)' }];
  }
  if (rec.digest !== requestDigest(rec.tool_name, rec.tool_input)) {
    return [409, { error: 'the request file was modified after it was written; refusing' }];
  }
  if (digest !== rec.digest) {
    return [409, { error: 'what the page showed does not match what is pending; reload' }];
  }
  if (behavior !== 'defer' && !isAllowEnabled(rec.tool_name, readConfig())) {
    return [403, { error: `${rec.tool_name} is not enabled for approval from the viewer` }];
  }

  const decision = { request_id: requestId, behavior, digest: rec.digest, ts: new Date().toISOString(), source: 'zoo-serve' };
  if (behavior === 'deny') {
    if (body.reason !== undefined && typeof body.reason !== 'string') return [400, { error: 'bad reason' }];
    decision.reason = (body.reason || '').slice(0, MAX_REASON_LENGTH);
  }

  try {
    writeDecisionExclusive(path.join(DECISIONS_DIR, `${requestId}.json`), decision);
  } catch (err) {
    if (err.code === 'EEXIST') return [409, { error: 'that request already has a decision' }];
    throw err;
  }
  return [200, { ok: true }];
}

function writeJsonPrivate(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o700 });
  fs.renameSync(tmp, file);
}

// Seen marks outlive their session's file once it's archived; drop those.
function pruneSeenMarks() {
  for (const entry of fs.readdirSync(SEEN_DIR)) {
    if (!fs.existsSync(path.join(SESSIONS_DIR, entry))) fs.rmSync(path.join(SEEN_DIR, entry), { force: true });
  }
}

// Opens the window a session lives in (lib/jump.js). The page names the session;
// everything opened is derived here from validated ids. ZOO_JUMP_DRY_RUN=1 (the
// tests) reports what would be opened instead of opening it.
function jump(body) {
  const { session_id: id } = body || {};
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return [400, { error: 'bad session_id' }];
  const session = readJsonSafe(path.join(SESSIONS_DIR, `${id}.json`));
  if (!session || session.session_id !== id) return [404, { error: 'no such session' }];
  const action = planJump(session, { home: os.homedir() });
  if (action.error) return [action.status, { error: action.error }];
  if (process.env.ZOO_JUMP_DRY_RUN === '1') return [200, { ok: true, kind: action.kind, dry_run: action }];
  try {
    performJump(action);
  } catch {
    return [502, { error: "couldn't open that window" }];
  }
  return [200, { ok: true, kind: action.kind }];
}

// Reading a session in its own window fires no hook, so the viewer can't know
// you've read it. Clicking a finished monster says so. The mark names the turn it
// covers (finished_at), so the next finished turn goes unread as usual.
function markSeen(body) {
  const { session_id: id, finished_at: finishedAt } = body || {};
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return [400, { error: 'bad session_id' }];
  if (typeof finishedAt !== 'string' || !finishedAt) return [400, { error: 'bad finished_at' }];

  const now = new Date();
  const file = readJsonSafe(path.join(SESSIONS_DIR, `${id}.json`));
  const s = file && applyUnreadCheck(file, now, unreadAfterSeconds(readConfig()));
  if (!s || !['done', 'unread'].includes(s.state) || s.finished_at !== finishedAt) {
    return [409, { error: 'that session has moved on since the page showed it' }];
  }

  writeJsonPrivate(path.join(SEEN_DIR, `${id}.json`), { session_id: id, finished_at: finishedAt, ts: now.toISOString() });
  fs.appendFileSync(EVENTS_LOG, JSON.stringify({
    ts: now.toISOString(),
    vendor: s.vendor || 'claude-code',
    session_id: id,
    event: 'ZooSeen',
    cwd: s.cwd || null,
    project_dir: s.project_dir || null,
    client: s.client || null,
    client_pid: s.client_pid || null,
    agent_id: null,
    agent_type: null,
    data: { finished_at: finishedAt, was: s.state },
  }) + '\n', { mode: 0o700 });
  pruneSeenMarks();
  return [200, { ok: true }];
}

// Guards shared by every request that changes something: an allowed Origin and a
// small JSON body. The router has already checked Host and the token.
function handleJsonPost(req, res, handler) {
  if (!ALLOWED_ORIGINS.has(String(req.headers.origin || ''))) return send(res, 403, { error: 'bad origin' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'expected application/json' });
  }
  readBody(req, (err, raw) => {
    try {
      if (err) return send(res, 413, { error: err.message });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'body is not JSON' });
      }
      const [status, out] = handler(body);
      send(res, status, out);
    } catch {
      send(res, 500, { error: 'internal error' });
    }
  });
}

function serveIndex(res) {
  fs.readFile(INDEX_HTML, 'utf8', (err, html) => {
    if (err) return send(res, 500, 'Could not read ui/index.html');
    send(res, 200, html.replace('__ZOO_TOKEN__', TOKEN), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
  });
}

function serveMonsterArt(res, species, file) {
  fs.readFile(path.join(MONSTERS_DIR, species, `${file}.png`), (err, png) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(png);
  });
}

const server = http.createServer((req, res) => {
  try {
    // Rejecting unexpected Host headers defeats DNS rebinding.
    if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) return send(res, 403, { error: 'bad host' });
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') return serveIndex(res);
    const art = req.method === 'GET' && MONSTER_ART_RE.exec(url.pathname);
    if (art) return serveMonsterArt(res, art[1], art[2]);

    if (!tokenMatches(req.headers['x-zoo-token'])) {
      return send(res, 403, { error: 'bad token: the zoo server restarted, reload the page' });
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      // Any open, token-bearing viewer counts, hidden tabs included: a browser
      // window covered by the terminal reports itself hidden, which is exactly when
      // the viewer is wanted. Claude Code's own prompt stays on screen either way.
      touchHeartbeat();
      return send(res, 200, readSessions(readConfig()));
    }
    if (req.method === 'GET' && url.pathname === '/requests') return send(res, 200, readRequests(readConfig()));
    if (req.method === 'POST' && url.pathname === '/decision') return handleJsonPost(req, res, decide);
    if (req.method === 'POST' && url.pathname === '/seen') return handleJsonPost(req, res, markSeen);
    if (req.method === 'POST' && url.pathname === '/jump') return handleJsonPost(req, res, jump);

    send(res, 404, { error: 'not found' });
  } catch {
    send(res, 500, { error: 'internal error' });
  }
});

for (const dir of [ZOO_DIR, SESSIONS_DIR, REQUESTS_DIR, DECISIONS_DIR, SEEN_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
const startupProblem = securityProblem();
if (startupProblem) {
  console.error(
    `zoo-serve: refusing to start: ${startupProblem}.\n` +
    'Anything that can write to ~/.zoo/decisions can approve a shell command, so the zoo ' +
    'directories must be private to you. Fix with: chmod 700 ~/.zoo ~/.zoo/requests ~/.zoo/decisions',
  );
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`zoo viewer at http://127.0.0.1:${PORT}`);
});
