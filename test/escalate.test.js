'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { periodKey, dueEscalations, noticeText } = require('../lib/escalate');

const T0 = Date.parse('2026-09-12T10:00:00.000Z');
const min = (m) => T0 + m * 60 * 1000;
const at = (m) => new Date(min(m)).toISOString();
const session = (id, state, sinceMin, extra = {}) => ({ session_id: id, name: id, state, since: at(sinceMin), ...extra });
const opts = (over = {}) => ({ nowMs: min(30), idleSeconds: 600, escalateMinutes: 10, idleMinutes: 5, sent: new Set(), ...over });

test('a session blocked long enough, with nobody at the Mac, is due', () => {
  const due = dueEscalations([session('a', 'blocked', 0)], opts());
  assert.deepEqual(due.map((s) => s.session_id), ['a']);
});

test('not due while someone is using the Mac', () => {
  assert.deepEqual(dueEscalations([session('a', 'blocked', 0)], opts({ idleSeconds: 299 })), []);
  assert.equal(dueEscalations([session('a', 'blocked', 0)], opts({ idleSeconds: 300 })).length, 1);
});

test('not due before escalate_minutes, and only blocked sessions count', () => {
  assert.deepEqual(dueEscalations([session('a', 'blocked', 21)], opts()), []);
  assert.equal(dueEscalations([session('a', 'blocked', 20)], opts()).length, 1);
  for (const state of ['working', 'done', 'unread', 'errored', 'spawned', 'stale']) {
    assert.deepEqual(dueEscalations([session('a', state, 0)], opts()), [], state);
  }
});

test('one notice per blocked period; a new block can escalate again', () => {
  const s = session('a', 'blocked', 0);
  const sent = new Set([periodKey(s)]);
  assert.deepEqual(dueEscalations([s], opts({ sent })), []);
  assert.equal(dueEscalations([session('a', 'blocked', 15)], opts({ sent })).length, 1);
});

test('escalate_minutes of 0 (or nonsense) turns escalation off', () => {
  for (const escalateMinutes of [0, -5, NaN, undefined]) {
    assert.deepEqual(dueEscalations([session('a', 'blocked', 0)], opts({ escalateMinutes })), [], String(escalateMinutes));
  }
});

test('oldest block first; unparseable timestamps are skipped', () => {
  const due = dueEscalations([session('new', 'blocked', 15), session('old', 'blocked', 2), { session_id: 'bad', state: 'blocked', since: 'x' }], opts());
  assert.deepEqual(due.map((s) => s.session_id), ['old', 'new']);
});

test('the notice gives the folder and the tool, never the chat title or the command', () => {
  const s = session('Client X merger memo', 'blocked', 0, { project_dir: '/Users/s/Developer/zoo' });
  const text = noticeText(s, { nowMs: min(12.5), toolName: 'Bash' });
  assert.equal(text, 'zoo: a session in zoo has been waiting 12 min for your permission to use Bash.');
  assert.ok(!text.includes('Client X'));
  assert.equal(noticeText(session('x', 'blocked', 0), { nowMs: min(10) }), 'zoo: a session has been waiting 10 min for your permission.');
  assert.equal(noticeText(session('x', 'blocked', 0, { cwd: '/tmp/jarvis/' }), { nowMs: min(10) }),
    'zoo: a session in jarvis has been waiting 10 min for your permission.');
});
