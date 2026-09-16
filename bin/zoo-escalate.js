#!/usr/bin/env node
'use strict';

// Hermes escalation (PLAN.md Phase 5; NOTES.md, Phase 5). launchd runs this every
// minute (launchd/com.example.zoo-escalate.plist, a template: copy and edit it for
// your own machine). If a session has been blocked for config.escalate_minutes and
// nobody has touched the Mac for config.escalate_idle_minutes, it hands Hermes one
// signed notice, and Hermes messages you. The zoo never sends a message itself.
//
// Hermes has no file it watches; its way in is a webhook route. The route is set up
// with --deliver-only, so no model reads the notice, and its URL and secret live in
// ~/.zoo/hermes.json ({"url": ..., "secret": ...}). Without that file this does nothing.
//
//   node bin/zoo-escalate.js          one check, as launchd runs it
//   node bin/zoo-escalate.js --test   send one test notice now

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { applyStaleCheck } = require('../lib/reducer');
const { isClientGone } = require('../lib/liveness');
const { mergeConfig, escalateMinutes, escalateIdleMinutes } = require('../lib/config');
const { periodKey, dueEscalations, noticeText } = require('../lib/escalate');

// A notice Hermes couldn't deliver (gateway restarting, say) is tried on the next
// few runs, then given up, so a broken Hermes doesn't mean a retry every minute forever.
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10000;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonPrivate(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o700 });
  fs.renameSync(tmp, file);
}

// Seconds since the last keyboard or pointer input, from IOKit. NaN if unreadable,
// which counts as "someone might be here": never escalate on a guess.
function macIdleSeconds() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/"HIDIdleTime" = (\d+)/);
    return m ? Number(m[1]) / 1e9 : NaN;
  } catch {
    return NaN;
  }
}

// Hermes's generic V2 webhook signature: hex HMAC-SHA256 of "<unix seconds>.<body>",
// checked against a 5-minute replay window.
function postToHermes(hermes, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ event_type: 'zoo.escalation', message });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', hermes.secret).update(`${ts}.${body}`).digest('hex');
    let url;
    try {
      url = new URL(hermes.url);
    } catch {
      resolve({ ok: false, status: 0, detail: 'bad url in hermes.json' });
      return;
    }
    const req = http.request(url, {
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Timestamp': ts,
        'X-Webhook-Signature-V2': signature,
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ ok: res.statusCode === 200 && json && json.status === 'delivered', status: res.statusCode, detail: json && json.status });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, status: 0, detail: err.message }));
    req.end(body);
  });
}

function paths(home) {
  const zoo = path.join(home, '.zoo');
  return {
    zoo,
    sessions: path.join(zoo, 'sessions'),
    requests: path.join(zoo, 'requests'),
    events: path.join(zoo, 'events.jsonl'),
    state: path.join(zoo, 'escalations.json'),
    hermes: path.join(zoo, 'hermes.json'),
    config: path.join(zoo, 'config.json'),
  };
}

// Blocked sessions whose Claude Code process is still alive. A session blocked past
// stale_hours is stale, not waiting, and isn't chased.
function blockedSessions(p, config, now) {
  let entries;
  try {
    entries = fs.readdirSync(p.sessions).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return entries
    .map((f) => readJsonSafe(path.join(p.sessions, f)))
    .filter((s) => s && typeof s === 'object' && !isClientGone(s))
    .map((s) => applyStaleCheck(s, now, config.stale_hours))
    .filter((s) => s.state === 'blocked');
}

// The tool the session's newest pending request asks for, if the zoo has it.
function toolFor(p, sessionId) {
  let entries;
  try {
    entries = fs.readdirSync(p.requests).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const mine = entries
    .map((f) => readJsonSafe(path.join(p.requests, f)))
    .filter((r) => r && r.session_id === sessionId && typeof r.tool_name === 'string')
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return mine.length ? mine[0].tool_name : null;
}

function logEvent(p, session, data) {
  const envelope = {
    ts: new Date().toISOString(),
    vendor: session.vendor || 'claude-code',
    session_id: session.session_id,
    event: 'ZooEscalation',
    cwd: session.cwd || null,
    project_dir: session.project_dir || null,
    client: session.client || null,
    client_pid: session.client_pid || null,
    agent_id: null,
    agent_type: null,
    data,
  };
  fs.appendFileSync(p.events, JSON.stringify(envelope) + '\n', { mode: 0o700 });
}

// One pass. Everything outside ~/.zoo is injectable so the tests can drive it.
async function run({ home = os.homedir(), idleSeconds = macIdleSeconds, post = postToHermes, now = new Date() } = {}) {
  const p = paths(home);
  const hermes = readJsonSafe(p.hermes);
  if (!hermes || typeof hermes.url !== 'string' || typeof hermes.secret !== 'string') return { skipped: 'no hermes.json' };
  const config = mergeConfig(readJsonSafe(p.config));
  const minutes = escalateMinutes(config);
  if (!minutes) return { skipped: 'escalate_minutes is 0' };

  const blocked = blockedSessions(p, config, now);
  // Forget periods that have ended, so the record stays small.
  const live = new Set(blocked.map(periodKey));
  const record = readJsonSafe(p.state) || {};
  let changed = false;
  for (const key of Object.keys(record)) {
    if (!live.has(key)) {
      delete record[key];
      changed = true;
    }
  }
  const done = new Set(Object.keys(record).filter((k) => record[k].delivered_at || record[k].attempts >= MAX_ATTEMPTS));

  const due = dueEscalations(blocked, {
    nowMs: now.getTime(),
    idleSeconds: blocked.length ? idleSeconds() : 0,
    escalateMinutes: minutes,
    idleMinutes: escalateIdleMinutes(config),
    sent: done,
  });

  const results = [];
  for (const s of due) {
    const key = periodKey(s);
    const attempt = ((record[key] && record[key].attempts) || 0) + 1;
    const outcome = await post(hermes, noticeText(s, { nowMs: now.getTime(), toolName: toolFor(p, s.session_id) }));
    record[key] = { attempts: attempt, last_attempt: now.toISOString(), ...(outcome.ok ? { delivered_at: now.toISOString() } : {}) };
    const result = outcome.ok ? 'delivered' : (attempt >= MAX_ATTEMPTS ? 'gave_up' : 'failed');
    logEvent(p, s, { since: s.since, outcome: result, attempt, http_status: outcome.status });
    results.push({ session_id: s.session_id, outcome: result });
  }
  if (due.length || changed) writeJsonPrivate(p.state, record);
  return { results };
}

async function main() {
  if (process.argv.includes('--test')) {
    const hermes = readJsonSafe(paths(os.homedir()).hermes);
    if (!hermes) {
      console.error('zoo-escalate: ~/.zoo/hermes.json is missing, so escalation is off.');
      process.exit(1);
    }
    const sample = noticeText({ since: new Date(Date.now() - 12 * 60000).toISOString(), project_dir: '/zoo' }, { nowMs: Date.now(), toolName: 'Bash' });
    const outcome = await postToHermes(hermes, `zoo: test notice, escalation is set up. A real one reads: "${sample.replace(/^zoo: /, '')}"`);
    console.log(outcome.ok ? 'delivered' : `not delivered (HTTP ${outcome.status}: ${outcome.detail})`);
    process.exit(outcome.ok ? 0 : 1);
  }
  try {
    await run();
  } catch (err) {
    console.error(`zoo-escalate: ${err && err.stack ? err.stack : err}`);
  }
}

if (require.main === module) main();

module.exports = { run, macIdleSeconds, postToHermes, MAX_ATTEMPTS };
