'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KEY, parseVmLine, advanceHeartbeat } = require('../lib/cowork-heartbeat');

const A = 'rcw-01wabcdefghijklmnopqrstu';
const B = 'rcw-01qzyxwvutsrqponmlkjihg';
const min = (m) => Date.UTC(2026, 8, 14, 3, 0, 0) + m * 60 * 1000;
const hit = (m, handle = null) => ({ at: min(m), handle });
const kinds = (events) => events.map((e) => e.event);

test('parses the VM log lines that mark Cowork activity, in local time', () => {
  const start = parseVmLine('2026-09-14 11:13:32 [info] [startVM] VM already connected');
  assert.deepEqual(start, { at: new Date(2026, 8, 14, 11, 13, 32).getTime(), handle: null });
  const run = parseVmLine(`2026-09-14 11:13:32 [info] [vmOneShot] Running: bash [2 arg(s)] as ${A}`);
  assert.equal(run.handle, A);
  assert.equal(parseVmLine('2026-09-14 11:13:32 [warn] [Keepalive] Already running'), null);
  assert.equal(parseVmLine('11:13:32 [info] SDK installed'), null);
});

test('a chat-only turn (no handle, nothing seen before) starts the Cowork monster', () => {
  const r = advanceHeartbeat(null, [hit(0)], min(0.2));
  assert.deepEqual(kinds(r.events), ['start']);
  assert.equal(r.events[0].handle, KEY);
  assert.equal(r.state.handles[KEY].phase, 'working');
});

test('working through activity, done after 2 quiet minutes, working again on the next turn', () => {
  let r = advanceHeartbeat(null, [hit(0, A), hit(0.5), hit(1, A)], min(1.5));
  assert.deepEqual(kinds(r.events), ['start']);
  r = advanceHeartbeat(r.state, [], min(2.9));
  assert.deepEqual(r.events, [], 'not yet: 1.9 minutes quiet');
  r = advanceHeartbeat(r.state, [], min(3));
  assert.deepEqual(kinds(r.events), ['done']);
  r = advanceHeartbeat(r.state, [hit(40)], min(40));
  assert.deepEqual(kinds(r.events), ['working'], 'even long after, a new turn wakes it');
});

test('after 30 quiet minutes the monster leaves, and the next activity starts it afresh', () => {
  let r = advanceHeartbeat(null, [hit(0)], min(0));
  r = advanceHeartbeat(r.state, [], min(31));
  assert.deepEqual(kinds(r.events), ['end']);
  assert.deepEqual(r.state, { handles: {} });
  r = advanceHeartbeat(r.state, [hit(32)], min(32));
  assert.deepEqual(kinds(r.events), ['start']);
});

test('two tasks at once share the one monster', () => {
  const r = advanceHeartbeat(null, [hit(0, A), hit(1, B), hit(1.2)], min(1.2));
  assert.deepEqual(kinds(r.events), ['start']);
  assert.deepEqual(Object.keys(r.state.handles), [KEY]);
});
