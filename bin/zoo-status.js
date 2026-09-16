#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyStaleCheck, applyUnreadCheck, applySeen, isForgottenSpawn } = require('../lib/reducer');
const { isClientGone } = require('../lib/liveness');
const { mergeConfig, unreadAfterSeconds, spawnedHideMinutes } = require('../lib/config');

const ZOO_DIR = path.join(os.homedir(), '.zoo');
const SESSIONS_DIR = path.join(ZOO_DIR, 'sessions');
const SEEN_DIR = path.join(ZOO_DIR, 'seen');
const CONFIG_FILE = path.join(ZOO_DIR, 'config.json');

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str.slice(0, len - 1) + ' ' : str + ' '.repeat(len - str.length);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    console.log('No sessions yet (~/.zoo/sessions does not exist).');
    return;
  }

  const config = mergeConfig(readJson(CONFIG_FILE));
  const now = new Date();
  const sessions = entries
    .map((f) => [readJson(path.join(SESSIONS_DIR, f)), readJson(path.join(SEEN_DIR, f))])
    .filter(([s]) => s && !isClientGone(s) && !isForgottenSpawn(s, now, spawnedHideMinutes(config)))
    .map(([s, seen]) => applyStaleCheck(applyUnreadCheck(applySeen(s, seen), now, unreadAfterSeconds(config)), now, config.stale_hours));

  if (sessions.length === 0) {
    console.log('No sessions.');
    return;
  }

  sessions.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  console.log(
    pad('NAME', 30) + pad('STATE', 10) + pad('SINCE', 26) +
    pad('LAST_EVENT', 18) + 'SESSION_ID'
  );
  for (const s of sessions) {
    console.log(
      pad(s.name, 30) + pad(s.state, 10) + pad(s.since, 26) +
      pad(s.last_event, 18) + s.session_id
    );
  }
}

main();
