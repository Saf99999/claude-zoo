'use strict';

// bin/zoo-escalate.js end to end against a throwaway ~/.zoo and a stand-in Hermes
// that checks the V2 signature the way gateway/platforms/webhook.py does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { run, postToHermes, MAX_ATTEMPTS } = require('../bin/zoo-escalate');

const SECRET = 'test-secret';
let home;
let zoo;
let hermes;
let received;
let reply;

function startHermes() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const ts = req.headers['x-webhook-timestamp'];
        const sig = req.headers['x-webhook-signature-v2'];
        const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
        const fresh = Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= 300;
        if (sig !== expected || !fresh) {
          res.writeHead(401).end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
        received.push({ url: req.url, payload: JSON.parse(body) });
        const [status, json] = reply();
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const writeSession = (id, extra) => fs.writeFileSync(path.join(zoo, 'sessions', `${id}.json`), JSON.stringify({
  session_id: id, name: 'Client X merger memo', state: 'blocked', since: ago(20), updated_at: ago(20),
  project_dir: '/Users/s/Developer/zoo', ...extra,
}));
const events = () => fs.readFileSync(path.join(zoo, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const away = () => 3600;

test.beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'zoo-esc-'));
  zoo = path.join(home, '.zoo');
  for (const d of ['sessions', 'requests']) fs.mkdirSync(path.join(zoo, d), { recursive: true, mode: 0o700 });
  hermes = await startHermes();
  received = [];
  reply = () => [200, { status: 'delivered' }];
  fs.writeFileSync(path.join(zoo, 'hermes.json'), JSON.stringify({
    url: `http://127.0.0.1:${hermes.address().port}/webhooks/zoo-escalation`, secret: SECRET,
  }));
});

test.afterEach(() => {
  hermes.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a long block while the Mac is idle sends one signed, folder-only notice', async () => {
  writeSession('s1');
  fs.writeFileSync(path.join(zoo, 'requests', 'r.json'), JSON.stringify({ session_id: 's1', tool_name: 'Bash', ts: ago(20), tool_input: { command: 'secret-command' } }));
  const out = await run({ home, idleSeconds: away });
  assert.deepEqual(out.results, [{ session_id: 's1', outcome: 'delivered' }]);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/webhooks/zoo-escalation');
  assert.equal(received[0].payload.event_type, 'zoo.escalation');
  assert.equal(received[0].payload.message, 'zoo: a session in zoo has been waiting 20 min for your permission to use Bash.');
  assert.ok(!JSON.stringify(received).includes('Client X') && !JSON.stringify(received).includes('secret-command'));
  const e = events().filter((x) => x.event === 'ZooEscalation');
  assert.deepEqual(e.map((x) => x.data.outcome), ['delivered']);

  await run({ home, idleSeconds: away });
  assert.equal(received.length, 1, 'one notice per blocked period');
});

test('nothing is sent while someone is at the Mac, or before escalate_minutes', async () => {
  writeSession('s1');
  await run({ home, idleSeconds: () => 30 });
  writeSession('s2', { since: ago(3) });
  await run({ home, idleSeconds: away });
  assert.deepEqual(received.map((r) => r.payload.message.includes('20 min')), [true], 'only the 20-minute block, and only once idle');
});

test('an idle clock that cannot be read never escalates', async () => {
  writeSession('s1');
  await run({ home, idleSeconds: () => NaN });
  assert.equal(received.length, 0);
});

test('a Hermes failure is retried on the next runs, then given up', async () => {
  writeSession('s1');
  reply = () => [502, { status: 'error' }];
  for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) await run({ home, idleSeconds: away });
  assert.equal(received.length, MAX_ATTEMPTS);
  assert.deepEqual(events().map((x) => x.data.outcome), ['failed', 'failed', 'gave_up']);
});

test('a new block of the same session escalates again; ended blocks are forgotten', async () => {
  writeSession('s1');
  await run({ home, idleSeconds: away });
  writeSession('s1', { since: ago(15) });
  await run({ home, idleSeconds: away });
  assert.equal(received.length, 2);
  const record = JSON.parse(fs.readFileSync(path.join(zoo, 'escalations.json'), 'utf8'));
  assert.deepEqual(Object.keys(record), [`s1@${JSON.parse(fs.readFileSync(path.join(zoo, 'sessions', 's1.json'))).since}`]);
});

test('off without hermes.json, with escalate_minutes 0, or when the session process is gone', async () => {
  writeSession('dead', { client_pid: 2 ** 22 + 12345 });
  assert.deepEqual((await run({ home, idleSeconds: away })).results, []);
  fs.writeFileSync(path.join(zoo, 'config.json'), JSON.stringify({ escalate_minutes: 0 }));
  writeSession('s1');
  assert.equal((await run({ home, idleSeconds: away })).skipped, 'escalate_minutes is 0');
  fs.rmSync(path.join(zoo, 'hermes.json'));
  assert.equal((await run({ home, idleSeconds: away })).skipped, 'no hermes.json');
  assert.equal(received.length, 0);
});

test('a wrong secret is refused by the receiver and reported as not delivered', async () => {
  const out = await postToHermes({ url: `http://127.0.0.1:${hermes.address().port}/webhooks/zoo-escalation`, secret: 'wrong' }, 'x');
  assert.deepEqual([out.ok, out.status], [false, 401]);
});
