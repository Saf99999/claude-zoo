'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { reduce, applyStaleCheck, monsterSeed } = require('../lib/reducer');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf8'));
}

function envelope(fixtureName, ts, overrides = {}) {
  const payload = { ...loadFixture(fixtureName), ...overrides };
  return {
    ts,
    vendor: 'claude-code',
    session_id: payload.session_id,
    event: payload.hook_event_name,
    cwd: payload.cwd,
    agent_id: payload.agent_id || null,
    agent_type: payload.agent_type || null,
    data: payload,
  };
}

test('SessionStart(startup) creates a spawned session', () => {
  const s = reduce(null, envelope('session-start', 't0'));
  assert.equal(s.state, 'spawned');
  assert.equal(s.session_id, 'sess-abc123');
  assert.equal(s.since, 't0');
  assert.equal(s.monster_seed, monsterSeed('/Users/saf/Developer/thing'));
});

test('UserPromptSubmit moves spawned -> working', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  assert.equal(s.state, 'working');
  assert.equal(s.since, 't1');
});

test('PermissionRequest moves working -> blocked instantly, records tool_use_id', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('permission-request', 't2'));
  assert.equal(s.state, 'blocked');
  assert.equal(s.pending_request, 'toolu_01Xyz');
});

test('Notification(permission_prompt) confirms blocked without needing a prior PermissionRequest', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('notification-permission-prompt', 't2'));
  assert.equal(s.state, 'blocked');
});

test('a tool event after blocked resolves back to working', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('permission-request', 't2'));
  s = reduce(s, envelope('post-tool-use', 't3'));
  assert.equal(s.state, 'working');
  assert.equal(s.pending_request, null);
});

test('a tool event while already working does not change state', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  const before = reduce(s, envelope('pre-tool-use', 't2'));
  assert.equal(before.state, 'working');
  assert.equal(before.since, 't1'); // since unchanged, only last_event/updated_at move
});

test('Stop moves working -> done and captures last_message (truncated to 200 chars)', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  const longMessage = 'x'.repeat(500);
  s = reduce(s, envelope('stop', 't2', { last_assistant_message: longMessage }));
  assert.equal(s.state, 'done');
  assert.equal(s.last_message.length, 200);
});

test('StopFailure moves working -> errored', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('stop-failure', 't2'));
  assert.equal(s.state, 'errored');
  assert.match(s.last_message, /overloaded/);
});

test('Notification(idle_prompt) moves done -> unread', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('stop', 't2'));
  s = reduce(s, envelope('notification-idle-prompt', 't3'));
  assert.equal(s.state, 'unread');
});

test('UserPromptSubmit exits done, unread, and errored back to working', () => {
  for (const fixture of ['stop', 'notification-idle-prompt', 'stop-failure']) {
    let s = reduce(null, envelope('session-start', 't0'));
    s = reduce(s, envelope('user-prompt-submit', 't1'));
    s = reduce(s, envelope(fixture, 't2'));
    s = reduce(s, envelope('user-prompt-submit', 't3'));
    assert.equal(s.state, 'working', `via ${fixture}`);
  }
});

test('SessionEnd moves any state -> gone', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('session-end', 't2'));
  assert.equal(s.state, 'gone');
});

test('SessionStart(source=compact) does not reset state', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('session-start', 't2', { source: 'compact' }));
  assert.equal(s.state, 'working');
  assert.equal(s.since, 't1');
});

test('SubagentStop records the child but leaves the parent state untouched', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('subagent-stop', 't2'));
  assert.equal(s.state, 'working');
  assert.equal(s.children['agent-9f2'].agent_type, 'Explore');
  assert.equal(s.children['agent-9f2'].state, 'done');
});

test('a PreToolUse carrying agent_id tracks the child as working', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('pre-tool-use', 't2', { agent_id: 'agent-9f2', agent_type: 'Explore' }));
  assert.equal(s.children['agent-9f2'].state, 'working');
});

test('applyStaleCheck marks a session stale once it exceeds stale_hours', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', new Date('2026-01-01T00:00:00.000Z').toISOString()));
  const now = new Date('2026-01-01T07:00:00.000Z'); // 7h later, default stale_hours=6
  const staled = applyStaleCheck(s, now, 6);
  assert.equal(staled.state, 'stale');
});

test('applyStaleCheck leaves a recently-updated session alone', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', new Date('2026-01-01T00:00:00.000Z').toISOString()));
  const now = new Date('2026-01-01T02:00:00.000Z'); // 2h later
  const same = applyStaleCheck(s, now, 6);
  assert.equal(same.state, 'working');
});

test('applyStaleCheck never touches a gone session', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('session-end', new Date('2020-01-01T00:00:00.000Z').toISOString()));
  const staled = applyStaleCheck(s, new Date(), 6);
  assert.equal(staled.state, 'gone');
});

test('SessionStart with the same id after stale revives to spawned', () => {
  let s = reduce(null, envelope('session-start', '2026-01-01T00:00:00.000Z'));
  s = reduce(s, envelope('user-prompt-submit', '2026-01-01T00:01:00.000Z'));
  s = applyStaleCheck(s, new Date('2099-01-01T00:00:00.000Z'), 6);
  assert.equal(s.state, 'stale');
  s = reduce(s, envelope('session-start', '2099-01-01T00:01:00.000Z'));
  assert.equal(s.state, 'spawned');
});

function zooDecision(ts, outcome, requestId) {
  return {
    ts,
    vendor: 'claude-code',
    session_id: 'sess-abc123',
    event: 'ZooDecision',
    cwd: '/Users/saf/Developer/thing',
    agent_id: null,
    agent_type: null,
    data: { request_id: requestId, outcome },
  };
}

function blockedWithRequest(requestId) {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  s = reduce(s, envelope('permission-request', 't2'));
  return { ...s, pending_request: requestId };
}

test('ZooDecision allow/deny moves blocked -> working and clears the request', () => {
  for (const outcome of ['allow', 'deny']) {
    const s = reduce(blockedWithRequest('req-1'), zooDecision('t3', outcome, 'req-1'));
    assert.equal(s.state, 'working', outcome);
    assert.equal(s.pending_request, null, outcome);
  }
});

test('ZooDecision defer/timeout leaves the session blocked (terminal prompt now owns it)', () => {
  for (const outcome of ['defer', 'timeout', 'rejected', 'viewer_gone']) {
    const s = reduce(blockedWithRequest('req-1'), zooDecision('t3', outcome, 'req-1'));
    assert.equal(s.state, 'blocked', outcome);
    assert.equal(s.pending_request, null, outcome);
  }
});

test('ZooDecision cancelled (answered in the terminal) moves blocked -> working', () => {
  const s = reduce(blockedWithRequest('req-1'), zooDecision('t3', 'cancelled', 'req-1'));
  assert.equal(s.state, 'working');
  assert.equal(s.pending_request, null);
});

test('a terminal No after cancel ends as unread once idle_prompt arrives', () => {
  let s = reduce(blockedWithRequest('req-1'), zooDecision('t3', 'cancelled', 'req-1'));
  s = reduce(s, envelope('notification-idle-prompt', 't4'));
  assert.equal(s.state, 'unread');
});

test('ZooDecision for an older request does not clear a newer pending one', () => {
  const s = reduce(blockedWithRequest('req-2'), zooDecision('t3', 'deny', 'req-1'));
  assert.equal(s.pending_request, 'req-2');
});

test('ZooDecision does not drag a session back to working if it already moved on', () => {
  let s = blockedWithRequest('req-1');
  s = reduce(s, envelope('stop', 't3'));
  s = reduce(s, zooDecision('t4', 'allow', 'req-1'));
  assert.equal(s.state, 'done');
});

const { applyUnreadCheck } = require('../lib/reducer');

test('name and monster stay with the starting folder when Claude changes directory', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  const seed = s.monster_seed;
  s = reduce(s, envelope('pre-tool-use', 't1', { cwd: '/Users/saf/Developer/thing/src/deep' }));
  assert.equal(s.name, 'thing');
  assert.equal(s.monster_seed, seed);
  assert.equal(s.cwd, '/Users/saf/Developer/thing/src/deep');
});

test("the client's project dir wins over the working directory", () => {
  const env = { ...envelope('session-start', 't0', { cwd: '/p/app/sub' }), project_dir: '/p/app' };
  const s = reduce(null, env);
  assert.equal(s.project_dir, '/p/app');
  assert.equal(s.name, 'app');
  assert.equal(s.monster_seed, monsterSeed('/p/app'));
});

test('a session title becomes the name, but the monster stays tied to the folder', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  const seed = s.monster_seed;
  s = reduce(s, envelope('user-prompt-submit', 't1', { session_title: 'Fix the login bug' }));
  assert.equal(s.name, 'Fix the login bug');
  assert.equal(s.monster_seed, seed);
  s = reduce(s, envelope('stop', 't2'));
  assert.equal(s.name, 'Fix the login bug', 'the title sticks once seen');
});

test('a fresh SessionStart resets the folder; compact does not', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('session-start', 't1', { source: 'compact', cwd: '/elsewhere' }));
  assert.equal(s.name, 'thing');
  s = reduce(s, envelope('session-start', 't2', { source: 'clear', cwd: '/Users/saf/Developer/other' }));
  assert.equal(s.name, 'other');
});

test('applyUnreadCheck turns a session done for a minute into unread, dated from then', () => {
  let s = reduce(null, envelope('session-start', '2026-01-01T00:00:00.000Z'));
  s = reduce(s, envelope('user-prompt-submit', '2026-01-01T00:00:01.000Z'));
  s = reduce(s, envelope('stop', '2026-01-01T00:00:10.000Z'));
  assert.equal(applyUnreadCheck(s, new Date('2026-01-01T00:01:09.000Z'), 60).state, 'done');
  const u = applyUnreadCheck(s, new Date('2026-01-01T00:01:10.000Z'), 60);
  assert.equal(u.state, 'unread');
  assert.equal(u.since, '2026-01-01T00:01:10.000Z');
});

test('applyUnreadCheck leaves every other state alone', () => {
  for (const state of ['spawned', 'working', 'blocked', 'unread', 'errored', 'stale', 'gone']) {
    const s = { state, since: '2020-01-01T00:00:00.000Z' };
    assert.equal(applyUnreadCheck(s, new Date(), 60), s, state);
  }
});

test('the client process id is recorded and kept up to date', () => {
  let s = reduce(null, { ...envelope('session-start', 't0'), client_pid: 111 });
  assert.equal(s.client_pid, 111);
  s = reduce(s, envelope('user-prompt-submit', 't1'));
  assert.equal(s.client_pid, 111, 'an event without a pid keeps the last one');
  s = reduce(s, { ...envelope('stop', 't2'), client_pid: 222 });
  assert.equal(s.client_pid, 222);
});

test('ZooSessionGone ends a session like SessionEnd', () => {
  let s = reduce(null, envelope('session-start', 't0'));
  s = reduce(s, envelope('permission-request', 't1'));
  s = reduce(s, {
    ts: 't2', vendor: 'claude-code', session_id: 'sess-abc123', event: 'ZooSessionGone',
    cwd: null, agent_id: null, agent_type: null, data: { reason: 'client process exited without SessionEnd' },
  });
  assert.equal(s.state, 'gone');
  assert.equal(s.pending_request, null);
});

const { applySeen } = require('../lib/reducer');

const T = (s) => `2026-01-01T00:${s}.000Z`;
const seenEnv = (ts, finishedAt) => ({
  ts, vendor: 'claude-code', session_id: 'sess-abc123', event: 'ZooSeen', cwd: '/x', data: { finished_at: finishedAt },
});

test('finished_at marks when a turn ended and clears when the next one starts', () => {
  let s = reduce(null, envelope('session-start', T('00:00')));
  assert.equal(s.finished_at, null);
  s = reduce(s, envelope('user-prompt-submit', T('00:01')));
  s = reduce(s, envelope('stop', T('00:10')));
  assert.equal(s.finished_at, T('00:10'));
  s = reduce(s, envelope('user-prompt-submit', T('00:20')));
  assert.equal(s.finished_at, null);
});

test('a turn with no Stop (answered No in the terminal) is ended by idle_prompt', () => {
  let s = reduce(null, envelope('session-start', T('00:00')));
  s = reduce(s, envelope('user-prompt-submit', T('00:01')));
  s = reduce(s, envelope('notification-idle-prompt', T('01:05')));
  assert.equal(s.state, 'unread');
  assert.equal(s.finished_at, T('01:05'));
});

test('a seen mark clears unread for that turn only', () => {
  let s = reduce(null, envelope('session-start', T('00:00')));
  s = reduce(s, envelope('user-prompt-submit', T('00:01')));
  s = reduce(s, envelope('stop', T('00:10')));
  const unread = applyUnreadCheck(s, new Date(T('02:00')), 60);
  assert.equal(unread.state, 'unread');

  const mark = { finished_at: T('00:10') };
  const seen = applySeen(unread, mark);
  assert.equal(seen.state, 'done');
  assert.equal(applyUnreadCheck(seen, new Date(T('59:00')), 60).state, 'done', 'stays done once seen');

  // An old mark does nothing for the next finished turn.
  s = reduce(s, envelope('user-prompt-submit', T('03:00')));
  s = reduce(s, envelope('stop', T('03:30')));
  const next = applySeen(applyUnreadCheck(s, new Date(T('05:00')), 60), mark);
  assert.equal(next.state, 'unread');
});

test('marking a session seen while still done keeps it from going unread', () => {
  let s = reduce(null, envelope('session-start', T('00:00')));
  s = reduce(s, envelope('user-prompt-submit', T('00:01')));
  s = reduce(s, envelope('stop', T('00:10')));
  const seen = applySeen(s, { finished_at: T('00:10') });
  assert.equal(applyUnreadCheck(seen, new Date(T('10:00')), 60).state, 'done');
});

test('applySeen leaves sessions alone without a matching mark', () => {
  const s = { state: 'unread', finished_at: T('00:10') };
  assert.equal(applySeen(s, null), s);
  assert.equal(applySeen(s, { finished_at: T('00:11') }), s);
  const noTurn = { state: 'working', finished_at: null };
  assert.equal(applySeen(noTurn, { finished_at: null }), noTurn);
});

test('ZooSeen in the log: unread -> done for the matching turn, and idle_prompt then leaves it alone', () => {
  let s = reduce(null, envelope('session-start', T('00:00')));
  s = reduce(s, envelope('user-prompt-submit', T('00:01')));
  s = reduce(s, envelope('stop', T('00:10')));
  s = reduce(s, seenEnv(T('00:30'), T('00:09')));
  assert.equal(s.seen_for, null, 'a mark for another turn is ignored');
  s = reduce(s, seenEnv(T('00:40'), T('00:10')));
  assert.equal(s.state, 'done');
  assert.equal(s.seen_for, T('00:10'));
  s = reduce(s, envelope('notification-idle-prompt', T('01:10')));
  assert.equal(s.state, 'done', 'already seen, so idle_prompt does not make it unread');
  s = reduce(s, envelope('user-prompt-submit', T('02:00')));
  s = reduce(s, envelope('stop', T('02:10')));
  s = reduce(s, envelope('notification-idle-prompt', T('03:10')));
  assert.equal(s.state, 'unread', 'the next turn goes unread as usual');
});

const { isForgottenSpawn } = require('../lib/reducer');

test('a session opened and never prompted is forgotten after the hide delay, even once stale', () => {
  const s = reduce(null, envelope('session-start', T('00:00')));
  assert.equal(isForgottenSpawn(s, new Date(T('09:59')), 10), false);
  assert.equal(isForgottenSpawn(s, new Date(T('10:01')), 10), true);
  assert.equal(isForgottenSpawn(s, new Date(T('59:00')), 0), false, '0 keeps them');
  const stale = applyStaleCheck(s, new Date('2026-01-01T07:00:00.000Z'), 6);
  assert.equal(stale.state, 'stale');
  assert.equal(isForgottenSpawn(stale, new Date('2026-01-01T07:00:00.000Z'), 10), true);
});

test('any session that has had a prompt is never forgotten, stale or not', () => {
  let s = reduce(null, envelope('session-start', T('00:00')));
  s = reduce(s, envelope('user-prompt-submit', T('00:01')));
  assert.equal(isForgottenSpawn(s, new Date(T('59:00')), 10), false);
  s = reduce(s, envelope('stop', T('00:10')));
  const stale = applyStaleCheck(s, new Date('2026-01-01T07:00:00.000Z'), 6);
  assert.equal(isForgottenSpawn(stale, new Date('2026-01-01T07:00:00.000Z'), 10), false);
});

const { COLORWAYS, pickColorway, colorwayOf } = require('../lib/reducer');

test('a new session picks a colour no other live session holds', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.equal(pickColorway(['teal', 'violet', 'rose']), 'indigo');
    assert.ok(['indigo', 'rose'].includes(pickColorway(['teal', 'violet'])));
  }
});

test('with all four taken, any colour, uniformly', () => {
  const all = ['teal', 'indigo', 'violet', 'rose'];
  assert.deepEqual([0, 0.25, 0.5, 0.75, 0.999999].map((r) => pickColorway(all, () => r)),
    ['teal', 'indigo', 'violet', 'rose', 'rose']);
  assert.equal(pickColorway([], () => 1), 'rose', 'a random source returning 1 stays in range');
});

test('the colour is set when the session is first seen and never recomputed', () => {
  const opts = { taken: () => ['teal', 'indigo', 'violet'], random: () => 0 };
  let s = reduce(null, envelope('session-start', T('00:00')), opts);
  assert.equal(s.colorway, 'rose');
  const seed = s.monster_seed;
  // Later events carry no options; the colour must survive them all.
  s = reduce(s, envelope('user-prompt-submit', T('00:01')));
  s = reduce(s, { ...envelope('session-start', T('00:02'), { cwd: '/elsewhere' }), project_dir: '/corrected/dir' });
  s = reduce(s, envelope('stop', T('00:03')));
  assert.equal(s.colorway, 'rose');
  assert.notEqual(s.monster_seed, seed, 'monster_seed still follows a corrected project_dir');
  assert.equal(s.monster_seed, require('../lib/reducer').monsterSeed('/corrected/dir'));
});

test('colorwayOf: the stored colour, else the old monster_seed derivation', () => {
  assert.equal(colorwayOf({ colorway: 'violet', monster_seed: '00ab' }), 'violet');
  assert.equal(colorwayOf({ monster_seed: '02ab' }), 'violet', 'no field: first byte mod 4');
  assert.equal(colorwayOf({ colorway: 'gold', monster_seed: '03ab' }), 'rose', 'unknown value: fall back');
  assert.equal(colorwayOf({}), 'teal');
  assert.deepEqual([...COLORWAYS], ['teal', 'indigo', 'violet', 'rose']);
});
