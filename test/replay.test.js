'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replay } = require('../lib/replay');

const at = (hms) => `2026-09-11T${hms}.000Z`;

function env(hms, sessionId, event, { cwd = `/x/${sessionId}`, agentType = null, ...data } = {}) {
  return {
    ts: at(hms),
    vendor: 'claude-code',
    session_id: sessionId,
    event,
    cwd,
    agent_id: agentType === null ? null : 'agent-1',
    agent_type: agentType,
    data: { hook_event_name: event, ...data },
  };
}

function scenario() {
  return [
    // alpha: a prompt answered No in the terminal with no viewer open; stays blocked until the next prompt
    env('10:00:00', 'alpha', 'SessionStart', { source: 'startup' }),
    env('10:00:05', 'alpha', 'UserPromptSubmit', { prompt: 'secret prompt text' }),
    env('10:00:10', 'alpha', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf secret' } }),
    env('10:00:10', 'alpha', 'ZooDecision', { request_id: null, outcome: 'no_viewer' }),
    env('10:12:00', 'alpha', 'UserPromptSubmit', { prompt: 'next' }),

    // bravo: finishes, goes unread while alpha is falsely blocked, then the user comes back
    env('10:00:00', 'bravo', 'SessionStart', { source: 'startup' }),
    env('10:00:01', 'bravo', 'UserPromptSubmit', { prompt: 'go' }),
    env('10:01:00', 'bravo', 'Stop', { last_assistant_message: 'secret reply' }),
    env('10:02:00', 'bravo', 'Notification', { notification_type: 'idle_prompt' }),
    env('10:20:00', 'bravo', 'UserPromptSubmit', { prompt: 'thanks' }),

    // charlie: a normal viewer allow, which must not be flagged
    env('10:05:00', 'charlie', 'SessionStart', { source: 'startup' }),
    env('10:05:01', 'charlie', 'UserPromptSubmit', { prompt: 'x' }),
    env('10:05:02', 'charlie', 'PermissionRequest', { tool_name: 'Write' }),
    env('10:05:07', 'charlie', 'ZooDecision', { request_id: 'r1', outcome: 'allow' }),

    // delta: a background task finishing ends an unread period, and a reply-suggestion SubagentStop
    env('10:06:00', 'delta', 'SessionStart', { source: 'startup' }),
    env('10:06:01', 'delta', 'UserPromptSubmit', { prompt: 'start a background job' }),
    env('10:06:05', 'delta', 'Stop', {}),
    env('10:07:05', 'delta', 'Notification', { notification_type: 'idle_prompt' }),
    env('10:08:00', 'delta', 'UserPromptSubmit', { prompt: '<task-notification>\n<status>completed</status>' }),
    env('10:08:01', 'delta', 'SubagentStop', { agentType: '', last_assistant_message: 'guessed reply' }),

    // echo: renamed mid-session as its cwd moves
    env('10:09:00', 'echo', 'SessionStart', { cwd: '/x/siege', source: 'startup' }),
    env('10:09:30', 'echo', 'UserPromptSubmit', { cwd: '/x/05 Proof', prompt: 'y' }),

    // two sessions in the same folder at the same time
    env('10:10:00', 'jar-1', 'SessionStart', { cwd: '/x/jarvis', source: 'startup' }),
    env('10:10:05', 'jar-2', 'SessionStart', { cwd: '/x/jarvis', source: 'startup' }),
    env('10:11:00', 'jar-1', 'UserPromptSubmit', { cwd: '/x/jarvis', prompt: 'z' }),
  ];
}

const byId = (result, id) => result.sessions.find((s) => s.id === id);

test('a blocked period ended by a new prompt is flagged, with what else was waiting', () => {
  const alpha = byId(replay(scenario()), 'alpha');
  assert.equal(alpha.flags.length, 1);
  const [flag] = alpha.flags;
  assert.ok(flag.reasons.some((r) => r.startsWith('ended by a new prompt')));
  assert.ok(flag.reasons.some((r) => r.startsWith('lasted 11.8m')));
  // Every session that needed attention while alpha's stale blob sat at the top,
  // including charlie's genuine five-second prompt.
  assert.deepEqual(flag.alsoWaiting, [
    { name: 'bravo', state: 'unread' },
    { name: 'charlie', state: 'blocked' },
    { name: 'delta', state: 'unread' },
  ]);
});

test('a normal viewer allow is not flagged', () => {
  const charlie = byId(replay(scenario()), 'charlie');
  assert.deepEqual(charlie.flags, []);
  assert.deepEqual(charlie.intervals.map((i) => i.state), ['spawned', 'working', 'blocked', 'working']);
});

test('an unread period records whether you or a background task ended it', () => {
  const result = replay(scenario());
  const bravoUnread = byId(result, 'bravo').intervals.find((i) => i.state === 'unread');
  assert.equal(bravoUnread.endedBy, 'UserPromptSubmit');
  assert.equal(bravoUnread.end - bravoUnread.start, 18 * 60 * 1000);

  const delta = byId(result, 'delta');
  assert.equal(delta.intervals.find((i) => i.state === 'unread').endedBy, 'UserPromptSubmit(background task)');
  assert.equal(delta.backgroundTurns, 1);
  assert.equal(delta.unlabelledSubagentStops, 1);
});

test('a session keeps its starting name, and shared folder names are reported', () => {
  const result = replay(scenario());
  assert.deepEqual(byId(result, 'echo').names, ['siege']);
  assert.deepEqual(result.duplicates, ['jarvis']);
});

test('a session done for longer than a minute shows as unread from then on', () => {
  const events = [
    env('09:00:00', 'foxtrot', 'SessionStart', { source: 'startup' }),
    env('09:00:01', 'foxtrot', 'UserPromptSubmit', { prompt: 'p' }),
    env('09:00:10', 'foxtrot', 'Stop', {}),
    env('09:05:10', 'foxtrot', 'UserPromptSubmit', { prompt: 'q' }),
  ];
  const f = byId(replay(events), 'foxtrot');
  assert.deepEqual(f.intervals.map((i) => [i.state, (i.end - i.start) / 1000]), [
    ['spawned', 1], ['working', 9], ['done', 60], ['unread', 240], ['working', 0],
  ]);
  assert.equal(f.intervals[3].endedBy, 'UserPromptSubmit');
});

test('output carries no prompt, command, or message text', () => {
  const text = JSON.stringify(replay(scenario()));
  for (const secret of ['secret prompt text', 'rm -rf secret', 'secret reply', 'guessed reply', 'task-notification>']) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
});

test('an open interval at the end of the log is marked as still going', () => {
  const jar1 = byId(replay(scenario()), 'jar-1');
  const last = jar1.intervals[jar1.intervals.length - 1];
  assert.equal(last.state, 'working');
  assert.equal(last.open, true);
});

test('replay: dismissing an unread session in the viewer ends the unread there', () => {
  const r = replay([
    env('10:00:00', 'gamma', 'SessionStart', { source: 'startup' }),
    env('10:00:05', 'gamma', 'UserPromptSubmit', { prompt: 'x' }),
    env('10:01:00', 'gamma', 'Stop'),
    env('10:05:00', 'gamma', 'ZooSeen', { finished_at: at('10:01:00') }),
    env('10:30:00', 'gamma', 'UserPromptSubmit', { prompt: 'y' }),
  ]);
  const g = r.sessions.find((s) => s.id === 'gamma');
  const states = g.intervals.map((iv) => `${iv.state}:${iv.startedBy}`);
  assert.deepEqual(states, [
    'spawned:SessionStart(startup)',
    'working:UserPromptSubmit',
    'done:Stop',
    'unread:no prompt for 1.0m',
    'done:ZooSeen',
    'working:UserPromptSubmit',
  ]);
  const unread = g.intervals.find((iv) => iv.state === 'unread');
  assert.equal(unread.endedBy, 'ZooSeen');
  assert.equal(unread.end - unread.start, 3 * 60 * 1000);
});

test('replay: a session seen before its minute is up never goes unread', () => {
  const r = replay([
    env('10:00:00', 'delta', 'SessionStart', { source: 'startup' }),
    env('10:00:05', 'delta', 'UserPromptSubmit', { prompt: 'x' }),
    env('10:01:00', 'delta', 'Stop'),
    env('10:01:20', 'delta', 'ZooSeen', { finished_at: at('10:01:00') }),
    env('10:30:00', 'delta', 'UserPromptSubmit', { prompt: 'y' }),
  ]);
  const d = r.sessions.find((s) => s.id === 'delta');
  assert.ok(!d.intervals.some((iv) => iv.state === 'unread'));
});
