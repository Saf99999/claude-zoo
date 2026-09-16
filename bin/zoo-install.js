#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeConfig, permissionHookTimeoutSeconds } = require('../lib/config');

const HOOK_PATH = path.resolve(__dirname, 'zoo-hook.js');

function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zoo', 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

const config = mergeConfig(readUserConfig());
const PERMISSION_TIMEOUT = permissionHookTimeoutSeconds(config);

const ASYNC_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'SessionEnd',
];

function hookEntry({ async, timeout, statusMessage }) {
  const hook = { type: 'command', command: `node ${HOOK_PATH}`, timeout, async };
  if (statusMessage) hook.statusMessage = statusMessage;
  return { matcher: '*', hooks: [hook] };
}

function buildHooksBlock() {
  const hooks = {};
  for (const event of ASYNC_EVENTS) hooks[event] = [hookEntry({ async: true, timeout: 600 })];
  hooks.PermissionRequest = [hookEntry({
    async: false,
    timeout: PERMISSION_TIMEOUT,
    statusMessage: 'Waiting for an answer in the zoo viewer (falls back here if it is closed)',
  })];
  return { hooks };
}

console.log('# Paste this into ~/.claude/settings.json');
console.log('# If settings.json already has a top-level "hooks" key, merge these');
console.log('# event names in as siblings -- do not replace the existing object.');
console.log('# Back up settings.json before editing it by hand.');
console.log('');
console.log(JSON.stringify(buildHooksBlock(), null, 2));
