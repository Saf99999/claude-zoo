# zoo

A macOS menu bar app that shows one small monster for every running agent session.

<p>
  <img src="ui/monsters/scarf/standing.png" height="110" alt="standing">
  <img src="ui/monsters/scarf/working.png" height="110" alt="working">
  <img src="ui/monsters/scarf/blocked.png" height="110" alt="blocked">
  <img src="ui/monsters/scarf/dancing.png" height="110" alt="done">
  <img src="ui/monsters/scarf/errored.png" height="110" alt="errored">
  <img src="ui/monsters/scarf/sleeping.png" height="110" alt="stale">
</p>

Run three or four Claude Code sessions at once and one of them is always finished, stuck, or dead, and you can't tell which without cycling through windows. The worst case is a session sitting on a permission prompt, because that one is waiting on you specifically and will wait forever.

zoo puts each session in the menu bar as a monster whose animation is its state. The monster that's freaking out is the one blocked on a permission prompt. Click it and you get the full request, with the command in monospace and nothing truncated, and you can approve or deny without leaving what you're doing. Approving is feeding the monster. Click a finished or working one and it brings that session's window forward instead.

This project isn't affiliated with or endorsed by Anthropic. Claude Code's hooks are documented; the Claude desktop app's session store and Cowork's logs are not, and either could change under it without warning.

## How it works

Claude Code fires hooks at every point in a session's life. zoo installs a hook script that writes each event to an append-only log and derives the session's current state from it. There is no daemon doing the watching; the hook script is the reducer, and it runs because Claude Code runs it.

```
Claude Code hook  ->  ~/.zoo/events.jsonl  ->  reducer  ->  ~/.zoo/sessions/<id>.json  ->  menu bar
```

The one exception is permission requests. The `PermissionRequest` hook blocks, writes the request where the app can see it, and waits for you to answer in the popover. If you answer in the terminal instead, Claude Code cancels the waiting hook and the card disappears. If nothing answers before the timeout, the hook exits silently and the normal terminal prompt is the only one. It never approves anything on its own.

## States

| State | Meaning | Monster |
|---|---|---|
| `spawned` | Session exists, no prompt yet | standing, breathing |
| `working` | Claude is processing | at a laptop, still |
| `blocked` | Waiting on a permission decision from you | freaking out, question bubble |
| `done` | Finished responding | dancing |
| `unread` | Finished 60 seconds ago and you haven't typed since | dancing, with a red badge |
| `errored` | Turn ended on an API error | sick, thermometer |
| `stale` | No event for six hours | asleep on its side |

The menu bar has two icons. The Code icon shows the worst state across Claude Code sessions, in the priority above; a screaming face means something wants you somewhere, and the number beside it counts blocked sessions. The Cowork icon (see below) shows only while a Cowork task is active.

Each session gets a colour when it starts, picked to differ from every other session currently on screen. There are four, so with five or more sessions running at once some repeat.

## The panel

Clicking either icon opens the same panel, positioned under the icon you clicked, sized to however many monsters are in it. It stays open until you close it: click either icon again, or the × at the right of the grip bar. Drag the grip to move it anywhere, including your other display; a double-click on the grip, or "Snap back to the icon" in the menu, puts it back under the icon. On two screens, clicking an icon on the other screen brings the panel over to that screen instead of closing it.

## Jump to session

Clicking a working, done, or unread monster brings that session's window forward: the Claude desktop app via its own `claude://` links, or the right Terminal.app tab if the session is running in one (found by walking the process tree from the session's recorded pid). The first Terminal jump triggers macOS's Automation permission prompt; allow it once.

## Cowork

Cowork tasks read from the Claude app's own audit logs (regular tasks) and VM activity log (chat-only turns, which write no audit log), so they show up as the same kind of monster the moment you start or reply to one, no hooks required. A quiet Cowork session shows working, then done, then leaves after 30 minutes of no activity, and starts fresh the next time. See [Security](#security) for exactly what gets read.

Scheduled Cowork tasks are never shown.

## Install

Requires macOS, Node 18 or later, and Rust if you're building the app yourself.

```bash
git clone https://github.com/Saf99999/zoo.git
cd zoo
npm run app:install        # builds and installs to ~/Applications/zoo.app
node bin/zoo-install.js    # prints the hooks block to paste
```

The last command prints a JSON block rather than editing anything. Paste it into `~/.claude/settings.json` under the top-level `hooks` key. If you already have hooks configured, merge the event names in as siblings instead of replacing the object, and back the file up first.

The app is not signed or notarized, so macOS will warn you the first time you open a build you didn't compile yourself. Building from source avoids that.

On first launch it registers itself to open at login. Right-click either menu bar icon to turn that off or quit.

Cowork support and Hermes escalation (below) each need a small poller running outside the app; `launchd/` has copy-and-edit templates for both, with the paths you need to fill in.

## Other commands

```bash
node bin/zoo-status.js     # current sessions and states, as text
node bin/zoo-replay.js     # replay the event log through the reducer
node bin/zoo-cowork.js     # poll Cowork's logs into the zoo (see launchd/com.example.zoo-cowork.plist)
node bin/zoo-escalate.js   # one Hermes escalation check (see launchd/com.example.zoo-escalate.plist)
```

`zoo-replay` prints names, states and times only. It never prints prompt text or assistant replies, and there's a test that checks it doesn't.

## Configuration

`~/.zoo/config.json`, all optional:

| Key | Default | What it does |
|---|---|---|
| `stale_hours` | 6 | How long without events before a session goes to sleep |
| `unread_after_seconds` | 60 | How long after finishing before a session is marked unread |
| `spawned_hide_minutes` | 10 | Hide sessions opened but never prompted |
| `approve_timeout_seconds` | 90 | How long a permission request waits before falling back to the terminal |
| `matcher_scope.enabled_tools` | `Bash`, `Write`, `Edit`, `MultiEdit` | Which tools get an Allow button. Everything else is shown read-only and answered in the terminal |
| `escalate_minutes` | 10 | How long a session must sit blocked before it's eligible for a Hermes escalation. `0` turns escalation off |
| `escalate_idle_minutes` | 5 | How long the Mac must have been idle before that escalation actually sends |
| `cowork_done_after_seconds` | 120 | How long a Cowork task can be quiet before it shows as done |
| `cowork_end_after_minutes` | 30 | How long a Cowork task can be quiet before its monster leaves entirely |

## Security

This app can approve shell commands on your behalf, so the design assumes that matters. It binds to localhost only, requires a per-process token that a cross-origin page cannot obtain, checks a hash of the exact request you were shown against the one being answered, and refuses to run at all if `~/.zoo` isn't `0700` and owned by you. A timeout falls back to the terminal prompt and never to allow.

[SECURITY.md](SECURITY.md) has the full threat model, what Cowork support reads, and what this deliberately doesn't protect against.

## Other agents

The event schema is vendor-neutral. Every event carries a `vendor` field, and the reducer and UI key on event names rather than anything Claude Code specific, so another agent becomes an adapter that maps its lifecycle onto the same names. Claude Code is implemented as a hook script; Cowork, which fires no hooks, is implemented instead as a small poller reading the Claude app's own logs, which is the pattern any hookless agent would need. An agent that can't report a pending permission request gets no `blocked` state, and that's a limit of the agent, not something the adapter can paper over.

## Status

Built in phases, each with its own acceptance test. Phases 0 through 5 are done: event capture, the state model, approve-from-the-bar, the monster art, the Tauri menu bar app, jump to session, Cowork support, and Hermes escalation.

Not done: subagents drawn as litters, adapters for other agents, and a mode where monsters float free on the desktop instead of living in a popover.

121 unit tests and 29 end-to-end scenarios on Node, plus 27 unit and 30 end-to-end against the Rust app.

## License

MIT.
