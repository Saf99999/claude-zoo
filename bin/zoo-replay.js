#!/usr/bin/env node
'use strict';

// Replays events.jsonl through the current reducer and prints a timeline for the
// state-model review. Prints only folder names, states, times and event names:
// never prompts, commands, file contents or Claude's messages.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { replay, formatDuration } = require('../lib/replay');

const file = process.argv[2] || path.join(os.homedir(), '.zoo', 'events.jsonl');

let lines;
try {
  lines = fs.readFileSync(file, 'utf8').split('\n');
} catch (err) {
  console.error(`zoo-replay: cannot read ${file}: ${err.message}`);
  process.exit(1);
}

const envelopes = [];
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    envelopes.push(JSON.parse(line));
  } catch {
    // a torn line from a concurrent write; skip it
  }
}

const result = replay(envelopes);
if (!result.sessions.length) {
  console.log('No events.');
  process.exit(0);
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
const out = [];
out.push(`zoo replay: ${clock(result.start)} to ${clock(result.end)}, ${result.events} events, ${result.sessions.length} sessions`);
out.push("Replayed through the current reducer, so this shows how today's model reads these events.");

let unreadTotal = 0;
let unreadByYou = 0;
let unreadDismissed = 0;
for (const s of result.sessions) {
  out.push('');
  out.push(`${s.names.join(' -> ')}  [${s.id.slice(0, 8)}]  ${s.events} events`);
  for (const iv of s.intervals) {
    const dur = formatDuration(iv.end - iv.start) + (iv.open ? ', still' : '');
    out.push(`  ${clock(iv.start)}  ${iv.state.padEnd(8)} ${dur.padEnd(12)} via ${iv.startedBy}`);
  }
  for (const f of s.flags) {
    out.push(`  ! blocked ${clock(f.start)}-${clock(f.end)}: ${f.reasons.join('; ')}`);
    if (f.alsoWaiting.length) {
      out.push(`    meanwhile also needing you: ${f.alsoWaiting.map((o) => `${o.name} (${o.state})`).join(', ')}`);
    }
  }
  for (const iv of s.intervals.filter((i) => i.state === 'unread')) {
    unreadTotal += 1;
    if (iv.endedBy === 'UserPromptSubmit') unreadByYou += 1;
    if (iv.endedBy === 'ZooSeen') unreadDismissed += 1;
    const how = iv.open
      ? 'still unread when the log ends'
      : `ended after ${formatDuration(iv.end - iv.start)} by ${iv.endedBy}`;
    out.push(`  ~ unread at ${clock(iv.start)}: ${how}`);
  }
  if (s.backgroundTurns) out.push(`  . ${s.backgroundTurns} turn(s) started by a background task finishing, not by you`);
  if (s.unlabelledSubagentStops) {
    out.push(`  . ${s.unlabelledSubagentStops} SubagentStop event(s) with no agent type (likely reply suggestions)`);
  }
}

const suspect = result.sessions.reduce((n, s) => n + s.flags.length, 0);
out.push('');
out.push(`Summary: ${suspect} suspect blocked period(s); ${unreadTotal} unread period(s), ${unreadByYou} ended by you typing, ${unreadDismissed} dismissed in the viewer.`);
if (result.duplicates.length) out.push(`Names shared by sessions running at the same time: ${result.duplicates.join(', ')}`);
console.log(out.join('\n'));
