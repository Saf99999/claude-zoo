'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planJump, performJump, parsePs, appBundle, DESKTOP_BUNDLE_ID } = require('../lib/jump');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-jump-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function desktopRecord(home, record, name = `${record.sessionId}.json`) {
  const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(record));
}

// A fake process table: pid -> [ppid, tty, command].
const table = (rows) => (pid) => (rows[pid] ? { ppid: rows[pid][0], tty: rows[pid][1], command: rows[pid][2] } : null);
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';

test('a desktop-app session jumps by its Claude app id, found by our session id', () => withHome((home) => {
  desktopRecord(home, { sessionId: 'local_abc-123', cliSessionId: 'cli-1', isArchived: false, title: 'x' });
  desktopRecord(home, { sessionId: 'local_other', cliSessionId: 'cli-2' });
  assert.deepEqual(planJump({ session_id: 'cli-1' }, { home }), { kind: 'desktop', url: 'claude://code/continue?session=local_abc-123' });
}));

test('an archived desktop session, or a malformed app id, is not jumped to', () => withHome((home) => {
  desktopRecord(home, { sessionId: 'local_gone', cliSessionId: 'cli-1', isArchived: true });
  assert.equal(planJump({ session_id: 'cli-1' }, { home }).status, 409);
  desktopRecord(home, { sessionId: 'local_bad;rm -rf', cliSessionId: 'cli-2' }, 'local_weird.json');
  // Not a desktop session after all, and no process: refused, never a link built from the bad id.
  const plan = planJump({ session_id: 'cli-2' }, { home, ps: () => null });
  assert.equal(plan.url, undefined);
  assert.equal(plan.status, 409);
}));

test('a terminal session in Terminal.app jumps to its tab by tty', () => withHome((home) => {
  const ps = table({ 500: [400, 'ttys003', 'claude'], 400: [300, 'ttys003', '-zsh'], 300: [200, 'ttys003', '/usr/bin/login'], 200: [1, '??', TERMINAL] });
  assert.deepEqual(planJump({ session_id: 's', client_pid: 500 }, { home, ps }),
    { kind: 'terminal-tab', tty: '/dev/ttys003', app: '/System/Applications/Utilities/Terminal.app' });
}));

test('other terminal apps are activated; claude.app bundles are skipped on the way up', () => withHome((home) => {
  const ps = table({
    500: [450, 'ttys001', '/Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude'],
    450: [400, 'ttys001', '/Users/x/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude'],
    400: [1, '??', '/Applications/Ghostty.app/Contents/MacOS/ghostty'],
  });
  assert.deepEqual(planJump({ session_id: 's', client_pid: 500 }, { home, ps }), { kind: 'app', app: '/Applications/Ghostty.app' });
}));

test('no window: no pid, a dead process, no tty, or no app above it', () => withHome((home) => {
  assert.equal(planJump(null, { home }).status, 404);
  assert.match(planJump({ session_id: 's' }, { home }).error, /no process/);
  assert.match(planJump({ session_id: 's', client_pid: 9 }, { home, ps: () => null }).error, /exited/);
  assert.match(planJump({ session_id: 's', client_pid: 9 }, { home, ps: table({ 9: [1, '??', 'claude'] }) }).error, /no window/);
  assert.match(planJump({ session_id: 's', client_pid: 9 }, { home, ps: table({ 9: [8, 'ttys002', 'claude'], 8: [1, 'ttys002', 'sshd'] }) }).error, /couldn't find/);
}));

test('performing: argv only, activation after the desktop link, app fallback for a missing tab', () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return cmd.endsWith('osascript') ? 'not found\n' : ''; };
  performJump({ kind: 'desktop', url: 'claude://code/continue?session=local_x' }, exec);
  assert.deepEqual(calls, [['/usr/bin/open', 'claude://code/continue?session=local_x'], ['/usr/bin/open', '-b', DESKTOP_BUNDLE_ID]]);

  calls.length = 0;
  performJump({ kind: 'terminal-tab', tty: '/dev/ttys003', app: '/System/Applications/Utilities/Terminal.app' }, exec);
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.equal(calls[0][calls[0].length - 1], '/dev/ttys003', 'the tty is an argv entry, not spliced into the script');
  assert.deepEqual(calls[1], ['/usr/bin/open', '-a', '/System/Applications/Utilities/Terminal.app']);

  calls.length = 0;
  performJump({ kind: 'terminal-tab', tty: '/dev/ttys003', app: '/x/Terminal.app' }, (cmd, args) => { calls.push([cmd, ...args]); return 'ok'; });
  assert.equal(calls.length, 1, 'tab found: no fallback');
});

test('ps lines and bundle paths parse', () => {
  assert.deepEqual(parsePs('  123 ttys004 /Applications/Some App.app/Contents/MacOS/Some App\n'),
    { ppid: 123, tty: 'ttys004', command: '/Applications/Some App.app/Contents/MacOS/Some App' });
  assert.equal(parsePs(''), null);
  assert.equal(appBundle('/Applications/Some App.app/Contents/MacOS/Some App'), '/Applications/Some App.app');
  assert.equal(appBundle('-zsh'), null);
  assert.equal(appBundle('/x/claude-code/claude.app/Contents/MacOS/claude'), null);
});

function coworkRecord(home, record) {
  const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions', 'acct', 'org');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.sessionId}.json`), JSON.stringify(record));
}

test('Cowork: the waiting link while blocked, the app otherwise, refused once gone', () => withHome((home) => {
  coworkRecord(home, { sessionId: 'local_cw-1', cliSessionId: 'cli-cw', isArchived: false });
  const s = { session_id: 'cli-cw', vendor: 'claude-cowork', state: 'blocked' };
  assert.deepEqual(planJump(s, { home }), { kind: 'desktop', url: 'claude://code/needs-input?session=local_cw-1' });
  assert.deepEqual(planJump({ ...s, state: 'done' }, { home }), { kind: 'desktop-app' });
  assert.equal(planJump({ ...s, session_id: 'cli-missing' }, { home }).status, 409);
  coworkRecord(home, { sessionId: 'local_cw-1', cliSessionId: 'cli-cw', isArchived: true });
  assert.match(planJump(s, { home }).error, /archived/);

  const calls = [];
  performJump({ kind: 'desktop-app' }, (cmd, args) => calls.push([cmd, ...args]));
  assert.deepEqual(calls, [['/usr/bin/open', '-b', DESKTOP_BUNDLE_ID]]);
}));

test('a Cowork heartbeat monster brings the Claude app forward', () => withHome((home) => {
  const s = { session_id: 'cowork-rcw-01wabcdefghijklmnopqrstu', vendor: 'claude-cowork', client: 'cowork-heartbeat', state: 'working' };
  assert.deepEqual(planJump(s, { home }), { kind: 'desktop-app' });
  assert.deepEqual(planJump({ ...s, state: 'done' }, { home }), { kind: 'desktop-app' });
}));
