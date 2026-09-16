'use strict';

// Which colorways are already taken, for a session the zoo sees for the first time
// (PLAN.md, locked decision 6). Shared by the Claude Code hook and the Cowork poller,
// so both kinds of session pick colours the same way.

const fs = require('fs');
const path = require('path');
const { colorwayOf, isForgottenSpawn } = require('./reducer');
const { isClientGone } = require('./liveness');
const { spawnedHideMinutes } = require('./config');

// The desktop app starts a few-second companion session next to a new chat, and it
// would otherwise take the free colour just before the chat asks. A resumed chat is
// spawned again but has finished turns (last_message), so it still counts.
function unprompted(s) {
  return s.state === 'spawned' && !s.last_message;
}

// Colour is for telling visible monsters apart, so only sessions the zoo is showing
// hold one: not ones whose process has gone, not ones opened but never used
// (spawned_hide_minutes), and not ones that have never had a prompt.
function newSessionOptions(sessionsDir, sessionId, config) {
  return {
    taken: () => {
      let entries;
      try {
        entries = fs.readdirSync(sessionsDir);
      } catch {
        return [];
      }
      const now = new Date();
      const hideMinutes = spawnedHideMinutes(config);
      return entries
        .filter((e) => e.endsWith('.json') && e !== `${sessionId}.json`)
        .map((e) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(sessionsDir, e), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter((s) => s && typeof s === 'object' && !isClientGone(s) && !isForgottenSpawn(s, now, hideMinutes) && !unprompted(s))
        .map(colorwayOf);
    },
  };
}

module.exports = { newSessionOptions, unprompted };
