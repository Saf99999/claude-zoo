'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CONFIG,
  MIN_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  mergeConfig,
  approveTimeoutSeconds,
  heartbeatSeconds,
} = require('../lib/config');

test('mergeConfig fills gaps from defaults and keeps overrides', () => {
  const c = mergeConfig({ stale_hours: 2, matcher_scope: { enabled_tools: ['Bash'] } });
  assert.equal(c.stale_hours, 2);
  assert.equal(c.approve_timeout_seconds, DEFAULT_CONFIG.approve_timeout_seconds);
  assert.deepEqual(c.matcher_scope.enabled_tools, ['Bash']);
});

test('mergeConfig survives a missing or garbage file', () => {
  assert.deepEqual(mergeConfig(null).matcher_scope.enabled_tools, ['Bash', 'Write', 'Edit', 'MultiEdit']);
  assert.equal(mergeConfig('nonsense').stale_hours, 6);
  assert.deepEqual(mergeConfig({ matcher_scope: 'x' }).matcher_scope.enabled_tools, ['Bash', 'Write', 'Edit', 'MultiEdit']);
});

test('an empty enabled_tools list is respected (nothing approvable from the viewer)', () => {
  assert.deepEqual(mergeConfig({ matcher_scope: { enabled_tools: [] } }).matcher_scope.enabled_tools, []);
});

test('approve timeout is clamped to what the hook timeout allows', () => {
  assert.equal(approveTimeoutSeconds({ approve_timeout_seconds: 90 }), 90);
  assert.equal(approveTimeoutSeconds({ approve_timeout_seconds: 1 }), MIN_WAIT_SECONDS);
  assert.equal(approveTimeoutSeconds({ approve_timeout_seconds: 99999 }), MAX_WAIT_SECONDS);
  assert.equal(approveTimeoutSeconds({ approve_timeout_seconds: 'abc' }), 90);
});

test('heartbeat seconds falls back on nonsense', () => {
  assert.equal(heartbeatSeconds({ viewer_heartbeat_seconds: 3 }), 3);
  assert.equal(heartbeatSeconds({ viewer_heartbeat_seconds: -1 }), 90);
});

const { unreadAfterSeconds, lingerMaxSeconds, permissionHookTimeoutSeconds, spawnedHideMinutes, escalateMinutes, escalateIdleMinutes } = require('../lib/config');

test('the PermissionRequest hook timeout covers the viewer window plus the linger', () => {
  assert.equal(permissionHookTimeoutSeconds(mergeConfig(null)), 3600);
  assert.equal(permissionHookTimeoutSeconds({ approve_timeout_seconds: 5, linger_max_seconds: 4 }), 39);
});

test('lingering can be switched off with 0, and nonsense falls back', () => {
  assert.equal(lingerMaxSeconds({ linger_max_seconds: 0 }), 0);
  assert.equal(lingerMaxSeconds({ linger_max_seconds: -5 }), 3480);
  assert.equal(lingerMaxSeconds({ linger_max_seconds: 1e9 }), 86400);
});

test('unread delay falls back on nonsense', () => {
  assert.equal(unreadAfterSeconds({ unread_after_seconds: 30 }), 30);
  assert.equal(unreadAfterSeconds({}), 60);
});

test('spawned hide delay: 0 turns it off, nonsense falls back to 10 minutes', () => {
  assert.equal(spawnedHideMinutes({}), 10);
  assert.equal(spawnedHideMinutes({ spawned_hide_minutes: 0 }), 0);
  assert.equal(spawnedHideMinutes({ spawned_hide_minutes: 30 }), 30);
  assert.equal(spawnedHideMinutes({ spawned_hide_minutes: -1 }), 10);
  assert.equal(spawnedHideMinutes({ spawned_hide_minutes: 'x' }), 10);
});

test('escalation delays: 0 is allowed (off, or no idle wait), nonsense falls back', () => {
  assert.equal(escalateMinutes({}), 10);
  assert.equal(escalateMinutes({ escalate_minutes: 0 }), 0);
  assert.equal(escalateMinutes({ escalate_minutes: -3 }), 10);
  assert.equal(escalateIdleMinutes({}), 5);
  assert.equal(escalateIdleMinutes({ escalate_idle_minutes: 'x' }), 5);
  assert.equal(escalateIdleMinutes({ escalate_idle_minutes: 2 }), 2);
});
