'use strict';

// Jump to the window a session lives in (NOTES.md, Phase 5: jump to session).
// src-tauri/src/jump.rs is a port of this file; the two must agree.
//
// Desktop-app sessions: the Claude app handles claude://code/continue?session=<id>,
// which opens an existing session without creating one. Undocumented (it's what the
// app builds for its own Spotlight results), so it can break with an app update, and
// it needs the app's own session id, found in its session store by our CLI id.
// Never claude-cli://open?cwd=...: that starts a new session.
//
// Terminal sessions: the session's process has a tty. In Terminal.app the tab with
// that tty is selected and brought forward; in any other app, the app is activated.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCAL_ID_RE = /^local_[A-Za-z0-9-]{1,64}$/; // the Claude app's own validation
const TTY_RE = /^ttys\d{1,4}$/;
const DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop';
const MAX_ANCESTORS = 15;

function desktopStore(home) {
  return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

function coworkStore(home) {
  return path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
}

// The Claude app's record of a session, found by our (CLI) session id. The store is
// <account>/<org>/local_<id>.json; files are skipped unless they mention the id.
function desktopSession(home, cliSessionId, root = desktopStore(home)) {
  const dirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  };
  for (const org of dirs(root).flatMap(dirs)) {
    let names;
    try {
      names = fs.readdirSync(org);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
      let raw;
      try {
        raw = fs.readFileSync(path.join(org, name), 'utf8');
      } catch {
        continue;
      }
      if (!raw.includes(cliSessionId)) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      if (record && record.cliSessionId === cliSessionId && LOCAL_ID_RE.test(record.sessionId)) {
        return { localId: record.sessionId, archived: Boolean(record.isArchived) };
      }
    }
  }
  return null;
}

// One `ps -o ppid=,tty=,comm=` line.
function parsePs(line) {
  const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(String(line || ''));
  return m ? { ppid: Number(m[1]), tty: m[2], command: m[3] } : null;
}

function psInfo(pid) {
  try {
    return parsePs(execFileSync('/bin/ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }));
  } catch {
    return null;
  }
}

// "/Applications/X.app/Contents/MacOS/X" -> "/Applications/X.app". Claude Code's own
// binary can live inside a claude.app bundle, which isn't the window we want.
function appBundle(command) {
  const m = /^(.*?\.app)\/Contents\/MacOS\//.exec(String(command || ''));
  if (!m || /\/claude\.app$/.test(m[1])) return null;
  return m[1];
}

// What a jump to this session would do, or why it can't. ps is injectable for tests.
function planJump(session, { home, ps = psInfo }) {
  if (!session || typeof session.session_id !== 'string') return { status: 404, error: 'no such session' };

  // Cowork has no link to open an existing task, but the app's "waiting for you" link
  // opens a Cowork session while it waits on a permission, the case that matters.
  // Any other Cowork state just brings the Claude app forward.
  // A heartbeat monster (lib/cowork-heartbeat.js) can't be matched to a task: bring
  // the Claude app forward.
  if (session.client === 'cowork-heartbeat') return { kind: 'desktop-app' };

  if (session.vendor === 'claude-cowork') {
    const cowork = desktopSession(home, session.session_id, coworkStore(home));
    if (!cowork) return { status: 409, error: 'that Cowork session is no longer in the Claude app' };
    if (cowork.archived) return { status: 409, error: 'that session is archived in the Claude app' };
    if (session.state === 'blocked') return { kind: 'desktop', url: `claude://code/needs-input?session=${cowork.localId}` };
    return { kind: 'desktop-app' };
  }

  const desktop = desktopSession(home, session.session_id);
  if (desktop) {
    if (desktop.archived) return { status: 409, error: 'that session is archived in the Claude app' };
    return { kind: 'desktop', url: `claude://code/continue?session=${desktop.localId}` };
  }

  const pid = session.client_pid;
  if (!Number.isInteger(pid) || pid <= 0) return { status: 409, error: 'the zoo has no process for this session' };
  const info = ps(pid);
  if (!info) return { status: 409, error: "that session's process has exited" };
  if (!TTY_RE.test(info.tty)) return { status: 409, error: 'that session has no window to open' };

  let next = info.ppid;
  for (let i = 0; i < MAX_ANCESTORS && next > 1; i += 1) {
    const up = ps(next);
    if (!up) break;
    const app = appBundle(up.command);
    if (app) {
      return app.endsWith('/Terminal.app')
        ? { kind: 'terminal-tab', tty: `/dev/${info.tty}`, app }
        : { kind: 'app', app };
    }
    next = up.ppid;
  }
  return { status: 409, error: "couldn't find the app that session runs in" };
}

const TERMINAL_TAB_SCRIPT = [
  'on run argv',
  '  set wanted to item 1 of argv',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if tty of t is wanted then',
  '          set selected of t to true',
  '          set index of w to 1',
  '          activate',
  '          return "ok"',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "not found"',
  'end run',
];

// Carries out a plan. Every argument is a validated id, tty or bundle path, passed as
// a separate argv entry: no shell, no string built into the script.
function performJump(action, exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000 })) {
  if (action.kind === 'desktop') {
    exec('/usr/bin/open', [action.url]);
    // The link can land in the background (anthropics/claude-code#65610); bring it forward.
    exec('/usr/bin/open', ['-b', DESKTOP_BUNDLE_ID]);
    return;
  }
  if (action.kind === 'terminal-tab') {
    let found = false;
    try {
      const args = TERMINAL_TAB_SCRIPT.flatMap((line) => ['-e', line]);
      found = String(exec('/usr/bin/osascript', [...args, action.tty])).trim() === 'ok';
    } catch {
      found = false; // no Automation permission, or Terminal refused: fall back to the app
    }
    if (!found) exec('/usr/bin/open', ['-a', action.app]);
    return;
  }
  if (action.kind === 'desktop-app') exec('/usr/bin/open', ['-b', DESKTOP_BUNDLE_ID]);
  if (action.kind === 'app') exec('/usr/bin/open', ['-a', action.app]);
}

module.exports = { planJump, performJump, desktopSession, coworkStore, parsePs, appBundle, LOCAL_ID_RE, TERMINAL_TAB_SCRIPT, DESKTOP_BUNDLE_ID };
