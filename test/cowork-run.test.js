'use strict';

// bin/zoo-cowork.js end to end against a throwaway HOME holding a fake Claude app
// Cowork store and a fake ~/.zoo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../bin/zoo-cowork');

const SECRET = 'TOP-SECRET-CLIENT-CONTENT';
let home;
let org;
let zoo;

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const readSession = (id) => JSON.parse(fs.readFileSync(path.join(zoo, 'sessions', `${id}.json`), 'utf8'));
const hasSession = (id) => fs.existsSync(path.join(zoo, 'sessions', `${id}.json`));
const events = () => (fs.existsSync(path.join(zoo, 'events.jsonl'))
  ? fs.readFileSync(path.join(zoo, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

function session(localId, meta) {
  fs.writeFileSync(path.join(org, `${localId}.json`), JSON.stringify({ sessionId: localId, isArchived: false, ...meta }));
  fs.mkdirSync(path.join(org, localId), { recursive: true });
}

function audit(localId, entries, { partial = '' } = {}) {
  const lines = entries.map((e) => JSON.stringify({ _audit_hmac: 'x', ...e })).join('\n');
  fs.appendFileSync(path.join(org, localId, 'audit.jsonl'), (lines ? `${lines}\n` : '') + partial);
}

const turnStart = (sec) => [{ type: 'user', message: { content: SECRET }, _audit_timestamp: iso(sec * 1000) }];
const request = (sec) => ({ type: 'system', subtype: 'permission_request', tool_name: 'Bash', tool_input: { command: SECRET }, _audit_timestamp: iso(sec * 1000) });
const response = (sec) => ({ type: 'system', subtype: 'permission_response', tool_name: 'Bash', decision: 'once', granted: true, _audit_timestamp: iso(sec * 1000) });
const result = (sec) => ({ type: 'result', subtype: 'success', _audit_timestamp: iso(sec * 1000) });

test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-cowork-'));
  org = path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions', 'acct', 'org');
  fs.mkdirSync(org, { recursive: true });
  zoo = path.join(home, '.zoo');
});

test.afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('a Cowork task shows as blocked, then done, titled, with no content in ~/.zoo', () => {
  session('local_task1', { cliSessionId: 'cli-task1', title: 'Client X memo', userSelectedFolders: ['/Users/x/Documents/Acme'] });
  audit('local_task1', [...turnStart(60), request(50)]);
  run({ home });
  let s = readSession('cli-task1');
  assert.equal(s.state, 'blocked');
  assert.equal(s.vendor, 'claude-cowork');
  assert.equal(s.name, 'Client X memo');
  assert.equal(s.project_dir, '/Users/x/Documents/Acme');
  assert.ok(['teal', 'indigo', 'violet', 'rose'].includes(s.colorway));

  audit('local_task1', [response(40), result(30)]);
  run({ home });
  s = readSession('cli-task1');
  assert.equal(s.state, 'done');
  assert.deepEqual(events().map((x) => x.event), ['SessionStart', 'PermissionRequest', 'PostToolUse', 'Stop']);

  for (const dir of ['sessions', 'archive']) {
    for (const f of fs.readdirSync(path.join(zoo, dir))) assert.ok(!fs.readFileSync(path.join(zoo, dir, f), 'utf8').includes(SECRET));
  }
  assert.ok(!fs.readFileSync(path.join(zoo, 'events.jsonl'), 'utf8').includes(SECRET));
  assert.ok(!fs.readFileSync(path.join(zoo, 'cowork.json'), 'utf8').includes(SECRET));
});

test('scheduled tasks are never shown', () => {
  session('local_sched', { cliSessionId: 'cli-sched', sessionType: 'scheduled', title: 'Model drop watch' });
  audit('local_sched', [...turnStart(60), request(50)]);
  run({ home });
  assert.equal(hasSession('cli-sched'), false);
  assert.deepEqual(events(), []);
});

test('a task quiet for stale_hours is tracked silently and appears when it moves again', () => {
  session('local_old', { cliSessionId: 'cli-old', title: 'Old task' });
  audit('local_old', [...turnStart(9 * 3600), result(9 * 3600 - 10)]);
  const old = (Date.now() - 8 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(org, 'local_old', 'audit.jsonl'), old, old);
  run({ home });
  assert.equal(hasSession('cli-old'), false);

  audit('local_old', turnStart(5));
  run({ home });
  assert.equal(readSession('cli-old').state, 'working');
  assert.deepEqual(events().map((x) => x.event), ['SessionStart', 'UserPromptSubmit']);
});

test('first sight shows only where a task stands now; a line still being written waits', () => {
  session('local_mid', { cliSessionId: 'cli-mid', title: 'Mid task' });
  audit('local_mid', [...turnStart(300), request(290), response(280), result(270), ...turnStart(20)],
    { partial: '{"type":"system","subtype":"permission_req' });
  run({ home });
  assert.equal(readSession('cli-mid').state, 'working');
  assert.deepEqual(events().map((x) => x.event), ['SessionStart', 'UserPromptSubmit']);

  fs.appendFileSync(path.join(org, 'local_mid', 'audit.jsonl'), `uest","tool_name":"Bash","_audit_timestamp":"${iso(5000)}"}\n`);
  run({ home });
  assert.equal(readSession('cli-mid').state, 'blocked');
});

test('archived or deleted in the Claude app ends the session in the zoo', () => {
  session('local_a', { cliSessionId: 'cli-a', title: 'A' });
  session('local_b', { cliSessionId: 'cli-b', title: 'B' });
  audit('local_a', turnStart(10));
  audit('local_b', turnStart(10));
  run({ home });
  assert.ok(hasSession('cli-a') && hasSession('cli-b'));

  session('local_a', { cliSessionId: 'cli-a', title: 'A', isArchived: true });
  fs.rmSync(path.join(org, 'local_b.json'));
  run({ home });
  assert.equal(hasSession('cli-a'), false);
  assert.equal(hasSession('cli-b'), false);
  assert.ok(fs.existsSync(path.join(zoo, 'archive', 'cli-a.json')));
  assert.ok(fs.existsSync(path.join(zoo, 'archive', 'cli-b.json')));
});

test('no Cowork data at all: nothing happens', () => {
  fs.rmSync(path.join(home, 'Library'), { recursive: true, force: true });
  assert.deepEqual(run({ home }), { skipped: 'no Cowork data' });
  assert.equal(fs.existsSync(zoo), false);
});

const HANDLE = 'rcw-01wabcdefghijklmnopqrstu';
const localStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function vmLog(lines) {
  const dir = path.join(home, 'Library', 'Logs', 'Claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'cowork_vm_node.log'), lines.map((l) => `${l}\n`).join(''));
}

test('heartbeat: current Cowork activity shows as the Cowork monster, done when quiet, gone later', () => {
  vmLog(['2026-01-01 00:00:00 [info] [vmOneShot] Running: bash [2 arg(s)] as rcw-01oldoldoldoldoldoldoldo']);
  const t0 = new Date();
  run({ home, now: t0 });
  assert.deepEqual(fs.readdirSync(path.join(zoo, 'sessions')), [], 'history before the first pass is not replayed');

  vmLog([
    `${localStamp(t0)} [info] [startVM] VM already connected`,
    `${localStamp(t0)} [info] [vmOneShot] Running: bash [2 arg(s)] as ${HANDLE}`,
    `${localStamp(t0)} [warn] [Keepalive] Already running`,
  ]);
  run({ home, now: new Date(t0.getTime() + 5000) });
  const id = 'cowork-live';
  let s = readSession(id);
  assert.equal(s.state, 'working');
  assert.equal(s.vendor, 'claude-cowork');
  assert.equal(s.client, 'cowork-heartbeat');
  assert.equal(s.name, 'Cowork');

  run({ home, now: new Date(t0.getTime() + 3 * 60 * 1000) });
  assert.equal(readSession(id).state, 'done');

  vmLog([`${localStamp(new Date(t0.getTime() + 4 * 60 * 1000))} [info] [startVM] VM already connected`]);
  run({ home, now: new Date(t0.getTime() + 4 * 60 * 1000) });
  assert.equal(readSession(id).state, 'working', 'a chat-only turn (no handle) wakes it');

  run({ home, now: new Date(t0.getTime() + 40 * 60 * 1000) });
  assert.equal(hasSession(id), false);
  assert.ok(fs.existsSync(path.join(zoo, 'archive', `${id}.json`)));
  assert.deepEqual(events().filter((e) => e.session_id === id).map((e) => e.event),
    ['SessionStart', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'SessionEnd']);
});

test('heartbeat: a chat-only turn with nothing seen before still shows the Cowork monster', () => {
  vmLog(['2026-01-01 00:00:00 [info] [startVM] VM already connected']);
  const t0 = new Date();
  run({ home, now: t0 });
  vmLog([`${localStamp(t0)} [info] [startVM] VM already connected`, `${localStamp(t0)} [warn] [Keepalive] Already running`]);
  run({ home, now: new Date(t0.getTime() + 3000) });
  assert.equal(readSession('cowork-live').state, 'working');
});
