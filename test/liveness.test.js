'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pidAlive, parsePid, isClientGone } = require('../lib/liveness');

test('pidAlive: this process yes, nonsense and a dead pid no', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive('123'), false);
  assert.equal(pidAlive(undefined), false);
});

test('parsePid accepts only positive integers', () => {
  assert.equal(parsePid('54925'), 54925);
  assert.equal(parsePid(undefined), null);
  assert.equal(parsePid(''), null);
  assert.equal(parsePid('-1'), null);
  assert.equal(parsePid('12.5'), null);
});

test('a session is gone only when it has a recorded pid that is no longer alive', () => {
  const dead = () => false;
  const alive = () => true;
  assert.equal(isClientGone({ state: 'working', client_pid: 42 }, dead), true);
  assert.equal(isClientGone({ state: 'working', client_pid: 42 }, alive), false);
  assert.equal(isClientGone({ state: 'working' }, dead), false, 'no pid: left to the stale timeout');
  assert.equal(isClientGone({ state: 'working', client_pid: null }, dead), false);
  assert.equal(isClientGone({ state: 'gone', client_pid: 42 }, dead), false, 'already gone');
  assert.equal(isClientGone(null, dead), false);
});
