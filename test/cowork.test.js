'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isShownSession, projectDir, pickEntry, advance, eventsFor } = require('../lib/cowork');

const at = (s) => `2026-09-14T10:00:${String(s).padStart(2, '0')}.000Z`;
const e = (type, subtype, sec, extra = {}) => ({ type, subtype: subtype || null, tool_name: null, at: at(sec), ...extra });

test('only regular Cowork tasks are shown: scheduled and internal session kinds are hidden', () => {
  assert.equal(isShownSession({ cliSessionId: 'c1', sessionType: undefined }), true);
  for (const sessionType of ['scheduled', 'agent', 'dispatch_child', 'radar', 'chat']) {
    assert.equal(isShownSession({ cliSessionId: 'c1', sessionType }), false, sessionType);
  }
  assert.equal(isShownSession({ sessionType: null }), false, 'no CLI session id');
  assert.equal(projectDir({ userSelectedFolders: ['/Users/x/Documents/Acme', '/other'] }), '/Users/x/Documents/Acme');
  assert.equal(projectDir({ userSelectedFolders: [] }), null);
});

test('pickEntry keeps type, subtype, tool name and time, and nothing else', () => {
  const picked = pickEntry({ type: 'system', subtype: 'permission_request', tool_name: 'Bash', _audit_timestamp: at(1),
    tool_input: { command: 'cat client-secrets.txt' }, message: { content: 'private' } });
  assert.deepEqual(picked, { type: 'system', subtype: 'permission_request', tool_name: 'Bash', at: at(1) });
  assert.equal(pickEntry('not an object'), null);
});

test('a turn: working, blocked until answered, then done', () => {
  const { state, transitions } = advance({}, [
    e('user', null, 0), e('system', 'init', 1), e('assistant', null, 2),
    e('system', 'permission_request', 3, { tool_name: 'Bash' }),
    e('system', 'thinking_tokens', 4),
    e('system', 'permission_response', 9, { tool_name: 'Bash' }),
    e('assistant', null, 10), e('result', 'success', 12),
  ]);
  assert.deepEqual(transitions.map((t) => t.phase), ['working', 'blocked', 'working', 'done']);
  assert.equal(transitions[2].resumed, true);
  assert.deepEqual(state, { phase: 'done', pending: 0, since: at(12) });
});

test('parallel prompts keep it blocked until every one is answered', () => {
  const { transitions, state } = advance({ phase: 'working' }, [
    e('system', 'permission_request', 1, { tool_name: 'Read' }),
    e('system', 'permission_request', 2, { tool_name: 'Bash' }),
    e('system', 'permission_response', 3, { tool_name: 'Read' }),
    e('assistant', null, 4),
  ]);
  assert.deepEqual(transitions.map((t) => t.phase), ['blocked']);
  assert.equal(state.pending, 1);
  const later = advance(state, [e('system', 'permission_response', 8, { tool_name: 'Bash' })]);
  assert.deepEqual(later.transitions.map((t) => t.phase), ['working']);
});

test('a non-success result is errored; a new prompt after done is working again', () => {
  const { transitions } = advance({ phase: 'done' }, [e('user', null, 1), e('result', 'error_max_turns', 5), e('user', null, 7)]);
  assert.deepEqual(transitions.map((t) => [t.phase, t.subtype]), [['working', undefined], ['errored', 'error_max_turns'], ['working', undefined]]);
});

test('events: the zoo lifecycle, titled, vendor claude-cowork, no content', () => {
  const meta = { cliSessionId: 'cli-9', title: 'Client X memo', userSelectedFolders: ['/Users/x/Documents/Acme'] };
  const transitions = [
    { phase: 'working', at: at(0) }, { phase: 'blocked', at: at(3), tool_name: 'Bash' },
    { phase: 'working', at: at(9), tool_name: 'Bash', resumed: true }, { phase: 'done', at: at(12) },
    { phase: 'errored', at: at(20), subtype: 'error_during_execution' },
  ];
  const events = eventsFor(meta, transitions, { needsStart: true });
  assert.deepEqual(events.map((x) => x.event), ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'StopFailure']);
  for (const x of events) {
    assert.equal(x.vendor, 'claude-cowork');
    assert.equal(x.client, 'cowork');
    assert.equal(x.session_id, 'cli-9');
    assert.equal(x.project_dir, '/Users/x/Documents/Acme');
    assert.equal(x.data.session_title, 'Client X memo');
  }
  assert.equal(events[0].ts, at(0));
  assert.deepEqual(events[2].data, { adapter: 'cowork', session_title: 'Client X memo', tool_name: 'Bash' });
  assert.equal(eventsFor(meta, transitions.slice(1, 2)).length, 1, 'no SessionStart unless asked');
});
