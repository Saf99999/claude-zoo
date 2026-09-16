'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_DENY_REASON,
  MAX_REASON_LENGTH,
  requestDigest,
  isAllowEnabled,
  buildRequestRecord,
  validateDecision,
  formatHookOutput,
  isHeartbeatFresh,
  waitForDecision,
} = require('../lib/permission');

const CONFIG = { matcher_scope: { enabled_tools: ['Bash', 'Write', 'Edit', 'MultiEdit'] } };
const INPUT = { command: 'rm -rf build/', description: 'Clean build dir' };
const DIGEST = requestDigest('Bash', INPUT);

function ctx(overrides = {}) {
  return { requestId: 'req-1', digest: DIGEST, toolName: 'Bash', config: CONFIG, ...overrides };
}

test('digest is stable across key order and changes with content', () => {
  assert.equal(requestDigest('Bash', { description: 'Clean build dir', command: 'rm -rf build/' }), DIGEST);
  assert.notEqual(requestDigest('Bash', { command: 'rm -rf /' }), DIGEST);
  assert.notEqual(requestDigest('Write', INPUT), DIGEST);
});

test('only configured tools are allow-enabled', () => {
  assert.equal(isAllowEnabled('Bash', CONFIG), true);
  assert.equal(isAllowEnabled('WebFetch', CONFIG), false);
  assert.equal(isAllowEnabled('Bash', {}), false);
});

test('request record for a non-enabled tool is display-only', () => {
  const rec = buildRequestRecord(
    { session_id: 's', cwd: '/x', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } },
    { requestId: 'req-2', ts: 't', digest: 'd', allowEnabled: false },
  );
  assert.equal(rec.mode, 'display_only');
  assert.equal(rec.allow_enabled, false);
});

test('a matching allow decision is accepted', () => {
  const r = validateDecision({ request_id: 'req-1', digest: DIGEST, behavior: 'allow' }, ctx());
  assert.deepEqual(r, { outcome: 'allow' });
});

test('deny carries a sanitised reason, with a default when blank', () => {
  const r1 = validateDecision({ request_id: 'req-1', digest: DIGEST, behavior: 'deny', reason: '  not now  ' }, ctx());
  assert.deepEqual(r1, { outcome: 'deny', reason: 'not now' });
  const r2 = validateDecision({ request_id: 'req-1', digest: DIGEST, behavior: 'deny', reason: '   ' }, ctx());
  assert.equal(r2.reason, DEFAULT_DENY_REASON);
  const r3 = validateDecision({ request_id: 'req-1', digest: DIGEST, behavior: 'deny', reason: 'x'.repeat(2000) }, ctx());
  assert.equal(r3.reason.length, MAX_REASON_LENGTH);
});

test('defer is accepted as defer', () => {
  const r = validateDecision({ request_id: 'req-1', digest: DIGEST, behavior: 'defer' }, ctx());
  assert.deepEqual(r, { outcome: 'defer' });
});

test('nothing malformed or mismatched can become allow', () => {
  const bad = [
    null,
    'allow',
    { behavior: 'allow' },
    { request_id: 'req-OTHER', digest: DIGEST, behavior: 'allow' },
    { request_id: 'req-1', digest: 'stale-digest', behavior: 'allow' },
    { request_id: 'req-1', digest: DIGEST, behavior: 'ALLOW' },
    { request_id: 'req-1', digest: DIGEST, behavior: true },
  ];
  for (const d of bad) {
    const r = validateDecision(d, ctx());
    assert.equal(r.outcome, 'rejected', `expected rejection for ${JSON.stringify(d)}`);
    assert.equal(formatHookOutput(r), null);
  }
});

test('allow for a tool that is not enabled is rejected even with a valid digest', () => {
  const digest = requestDigest('WebFetch', { url: 'https://example.com' });
  const r = validateDecision(
    { request_id: 'req-1', digest, behavior: 'allow' },
    ctx({ toolName: 'WebFetch', digest }),
  );
  assert.equal(r.outcome, 'rejected');
});

test('hook output: allow and deny print JSON, everything else prints nothing', () => {
  const allow = JSON.parse(formatHookOutput({ outcome: 'allow' }));
  assert.equal(allow.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(allow.hookSpecificOutput.decision.behavior, 'allow');

  const deny = JSON.parse(formatHookOutput({ outcome: 'deny', reason: 'nope' }));
  assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(deny.hookSpecificOutput.decision.message, 'nope');

  for (const outcome of ['defer', 'timeout', 'rejected', 'viewer_gone', 'no_viewer', 'display_only']) {
    assert.equal(formatHookOutput({ outcome }), null, outcome);
  }
});

test('heartbeat freshness', () => {
  assert.equal(isHeartbeatFresh(1000, 5000, 10), true);
  assert.equal(isHeartbeatFresh(1000, 12000, 10), false);
  assert.equal(isHeartbeatFresh(undefined, 5000, 10), false);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('waitForDecision returns the decision once it appears', async () => {
  const clock = fakeClock();
  const r = await waitForDecision({
    readDecision: () => (clock.now() >= 1000 ? { behavior: 'allow' } : null),
    isViewerAlive: () => true,
    timeoutMs: 90000,
    intervalMs: 250,
    ...clock,
  });
  assert.equal(r.kind, 'decision');
  assert.equal(clock.now(), 1000);
});

test('waitForDecision times out at the deadline and never invents a decision', async () => {
  const clock = fakeClock();
  const r = await waitForDecision({
    readDecision: () => null,
    isViewerAlive: () => true,
    timeoutMs: 90000,
    intervalMs: 250,
    ...clock,
  });
  assert.equal(r.kind, 'timeout');
  assert.equal(clock.now(), 90000);
});

test('waitForDecision gives up early when the viewer goes away', async () => {
  const clock = fakeClock();
  const r = await waitForDecision({
    readDecision: () => null,
    isViewerAlive: () => clock.now() < 3000,
    timeoutMs: 90000,
    intervalMs: 250,
    ...clock,
  });
  assert.equal(r.kind, 'viewer_gone');
  assert.equal(clock.now(), 3000);
});
