'use strict';

const DEFAULT_CONFIG = Object.freeze({
  stale_hours: 6,
  // Claude Code only sends idle_prompt in terminal sessions, so the zoo marks a
  // finished session unread itself once it has been done this long.
  unread_after_seconds: 60,
  // A session opened but never given a prompt leaves the zoo after this long, and
  // comes back the moment you type in it. 0 keeps them on screen.
  spawned_hide_minutes: 10,
  // Hermes escalation (bin/zoo-escalate.js): a session blocked this long while the
  // Mac has been idle escalate_idle_minutes gets one notice through Hermes. 0 is off.
  escalate_minutes: 10,
  escalate_idle_minutes: 5,
  approve_timeout_seconds: 90,
  // Browsers poll hidden tabs about once a minute, so this has to outlast that or
  // a viewer sitting behind another window would count as closed.
  viewer_heartbeat_seconds: 90,
  // Once the viewer's chance has passed, the PermissionRequest hook stays alive,
  // holding nothing, until Claude Code cancels it: the only sign that the prompt
  // was answered in the terminal. 0 turns lingering off.
  linger_max_seconds: 3480,
  matcher_scope: Object.freeze({
    enabled_tools: Object.freeze(['Bash', 'Write', 'Edit', 'MultiEdit']),
  }),
});

const MIN_WAIT_SECONDS = 5;
const MAX_WAIT_SECONDS = 590;
const MAX_LINGER_SECONDS = 86400;
const HOOK_TIMEOUT_MARGIN_SECONDS = 30;

function mergeConfig(fromFile) {
  const file = fromFile && typeof fromFile === 'object' ? fromFile : {};
  const scope = file.matcher_scope && typeof file.matcher_scope === 'object' ? file.matcher_scope : {};
  return {
    ...DEFAULT_CONFIG,
    ...file,
    matcher_scope: { ...DEFAULT_CONFIG.matcher_scope, ...scope },
  };
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function approveTimeoutSeconds(config) {
  const n = Number(config.approve_timeout_seconds);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.approve_timeout_seconds;
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, n));
}

function heartbeatSeconds(config) {
  return positive(config.viewer_heartbeat_seconds, DEFAULT_CONFIG.viewer_heartbeat_seconds);
}

function unreadAfterSeconds(config) {
  return positive(config.unread_after_seconds, DEFAULT_CONFIG.unread_after_seconds);
}

function spawnedHideMinutes(config) {
  const n = Number(config.spawned_hide_minutes);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONFIG.spawned_hide_minutes;
  return n;
}

function nonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function escalateMinutes(config) {
  return nonNegative(config.escalate_minutes, DEFAULT_CONFIG.escalate_minutes);
}

function escalateIdleMinutes(config) {
  return nonNegative(config.escalate_idle_minutes, DEFAULT_CONFIG.escalate_idle_minutes);
}

function lingerMaxSeconds(config) {
  const n = Number(config.linger_max_seconds);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CONFIG.linger_max_seconds;
  return Math.min(MAX_LINGER_SECONDS, n);
}

// The PermissionRequest hook's settings.json timeout. It covers the viewer window
// plus the linger, with a margin so the hook always exits on its own first: a kill
// from Claude Code would look exactly like "answered in the terminal".
function permissionHookTimeoutSeconds(config) {
  return approveTimeoutSeconds(config) + lingerMaxSeconds(config) + HOOK_TIMEOUT_MARGIN_SECONDS;
}

module.exports = {
  DEFAULT_CONFIG,
  MIN_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  mergeConfig,
  approveTimeoutSeconds,
  heartbeatSeconds,
  unreadAfterSeconds,
  spawnedHideMinutes,
  escalateMinutes,
  escalateIdleMinutes,
  lingerMaxSeconds,
  permissionHookTimeoutSeconds,
};
