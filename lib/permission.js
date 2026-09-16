'use strict';

const crypto = require('crypto');

const DEFAULT_DENY_REASON = 'Denied by the user from the zoo viewer.';
const MAX_REASON_LENGTH = 500;

// Stable JSON (sorted keys) so the hook and the server hash identical content
// to the same digest regardless of key order after a round trip through disk.
function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

// Binds a decision to the exact tool call that was displayed: the hook refuses
// any decision whose digest doesn't match the payload it is answering for.
function requestDigest(toolName, toolInput) {
  return crypto.createHash('sha256')
    .update(canonical({ tool_name: toolName, tool_input: toolInput }))
    .digest('hex');
}

function enabledTools(config) {
  const list = config && config.matcher_scope && config.matcher_scope.enabled_tools;
  return Array.isArray(list) ? list : [];
}

function isAllowEnabled(toolName, config) {
  return enabledTools(config).includes(toolName);
}

function buildRequestRecord(payload, { requestId, ts, digest, allowEnabled }) {
  return {
    request_id: requestId,
    session_id: payload.session_id || null,
    cwd: payload.cwd || null,
    agent_id: payload.agent_id || null,
    agent_type: payload.agent_type || null,
    tool_name: payload.tool_name || null,
    tool_input: payload.tool_input === undefined ? null : payload.tool_input,
    ts,
    digest,
    allow_enabled: allowEnabled,
    mode: allowEnabled ? 'awaiting' : 'display_only',
  };
}

function sanitizeReason(reason) {
  if (typeof reason !== 'string') return DEFAULT_DENY_REASON;
  const trimmed = reason.trim().slice(0, MAX_REASON_LENGTH);
  return trimmed || DEFAULT_DENY_REASON;
}

// Anything that isn't an exact, well-formed match for this request is
// 'rejected', which the hook treats the same as defer: fall back to the
// terminal prompt. There is no path from a malformed decision to 'allow'.
function validateDecision(decision, { requestId, digest, toolName, config }) {
  if (!decision || typeof decision !== 'object') {
    return { outcome: 'rejected', why: 'decision is not an object' };
  }
  if (decision.request_id !== requestId) {
    return { outcome: 'rejected', why: 'request_id mismatch' };
  }
  if (decision.digest !== digest) {
    return { outcome: 'rejected', why: 'digest mismatch: decision was made against different content' };
  }
  if (decision.behavior === 'defer') {
    return { outcome: 'defer' };
  }
  if (decision.behavior !== 'allow' && decision.behavior !== 'deny') {
    return { outcome: 'rejected', why: `unknown behavior ${JSON.stringify(decision.behavior)}` };
  }
  if (!isAllowEnabled(toolName, config)) {
    return { outcome: 'rejected', why: `${toolName} is not enabled for approval from the viewer` };
  }
  if (decision.behavior === 'allow') {
    return { outcome: 'allow' };
  }
  return { outcome: 'deny', reason: sanitizeReason(decision.reason) };
}

// The only function that knows Claude Code's PermissionRequest output shape.
// Returns null for every outcome that should fall through to the normal prompt.
function formatHookOutput(result) {
  if (result.outcome === 'allow') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
  }
  if (result.outcome === 'deny') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: result.reason },
      },
    });
  }
  return null;
}

function isHeartbeatFresh(mtimeMs, nowMs, maxAgeSeconds) {
  if (typeof mtimeMs !== 'number' || Number.isNaN(mtimeMs)) return false;
  return nowMs - mtimeMs <= maxAgeSeconds * 1000;
}

// Poll loop with every side effect injected, so tests can drive it with a fake clock.
async function waitForDecision({ readDecision, isViewerAlive, now, sleep, timeoutMs, intervalMs }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const decision = readDecision();
    if (decision !== null) return { kind: 'decision', decision };
    if (now() >= deadline) return { kind: 'timeout' };
    if (!isViewerAlive()) return { kind: 'viewer_gone' };
    await sleep(intervalMs);
  }
}

module.exports = {
  DEFAULT_DENY_REASON,
  MAX_REASON_LENGTH,
  canonical,
  requestDigest,
  enabledTools,
  isAllowEnabled,
  buildRequestRecord,
  sanitizeReason,
  validateDecision,
  formatHookOutput,
  isHeartbeatFresh,
  waitForDecision,
};
