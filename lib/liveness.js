'use strict';

// True if a process with this pid exists. EPERM means it exists but belongs to
// someone else, which still counts as alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function parsePid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A session whose agent process has exited is over, even if its SessionEnd never
// arrived (headless teardown, a crash, a force-quit terminal). A session with no
// recorded pid can't be checked and is left to the stale timeout. A reused pid
// errs toward "still alive", which the stale timeout also covers.
function isClientGone(session, alive = pidAlive) {
  if (!session || session.state === 'gone') return false;
  if (!Number.isInteger(session.client_pid) || session.client_pid <= 0) return false;
  return !alive(session.client_pid);
}

module.exports = { pidAlive, parsePid, isClientGone };
