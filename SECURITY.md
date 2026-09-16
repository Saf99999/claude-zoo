# Security

zoo can approve shell commands on your behalf, and it reads activity out of the Claude desktop app's own local data. That's the reason this file exists, and it's worth reading before you install it.

## What the app actually does

Claude Code asks permission before running certain tools. Normally you answer in the terminal. zoo installs a `PermissionRequest` hook that blocks that prompt, shows the request in a menu bar popover, and prints an allow or deny decision back to Claude Code based on what you click.

Anything that can write to `~/.zoo/decisions/` can therefore approve a command that Claude Code is about to run as you. That directory is the asset worth protecting, and everything below follows from it.

Separately, if you enable Cowork support or Hermes escalation, zoo reads files under the Claude app's own `~/Library/Application Support/Claude` folder and `~/Library/Logs/Claude`, and can bring windows forward or drive Terminal.app with AppleScript. Both are covered below.

## The guarantee

zoo never approves anything on its own. There is no auto-allow, no allowlist that acts without you, and no "approve if it looks safe" path. If nobody clicks, the request times out, the hook exits silently, and Claude Code's own terminal prompt is the only way to answer. A timeout falls back to the terminal, never to allow.

This is a design constraint, not a default you can change in config.

## What you approve is what you saw

Each request carries a SHA-256 digest of the canonical `{tool_name, tool_input}`. Three separate places check it:

The page echoes the digest back with your decision. The server recomputes it from the request file rather than trusting the stored value, so a request file edited between display and click is refused. The hook checks the digest against the payload it is actually answering, so a decision written for one request cannot be applied to another.

The popover shows every field of `tool_input`. For `Bash` the command comes first, in full, in monospace, with nothing truncated and no ellipsis. Other fields, including `dangerouslyDisableSandbox`, are shown below rather than hidden.

## Local server

The app serves its UI from `127.0.0.1` and only from there.

Any request whose `Host` header is not `127.0.0.1` or `localhost` on the expected port gets a 403, which closes off DNS rebinding. Every API call must carry a random token generated fresh per process and embedded in the page. A page on another origin cannot read that token, and cannot send it as a custom header without a preflight the server never answers.

Every route that changes something (`POST /decision`, `/seen`, `/jump`, `/popover-height`) additionally requires an allowed `Origin` and `application/json`, and caps the body at 16KB. `/decision` accepts only UUID-shaped request ids so there is no path traversal, refuses a decision for any request whose hook process has already exited, and writes the decision file create-exclusive so a second click cannot overwrite the first. `/jump` and `/seen` accept only session ids the server already knows about. `/popover-height` only ever resizes the app's own window and does nothing when the app is running headless (`--serve-only`).

The page sets `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Request content reaches the DOM through `textContent` only. Buttons stay disabled until the request has been scrolled to the end and has been on screen for a full second. Allow responds to pointer events only and ignores keyboard activation, and nothing is autofocused, so a stray keypress or a scripted Enter cannot approve anything.

## File permissions

`~/.zoo` and everything under it is `0700` and owned by you. The server refuses to start if that isn't true, and re-checks before writing any decision rather than trusting the startup check.

The hook refuses to print an allow unless the decision file is a regular file you own, the request id and digest both match, `behavior` is exactly the string `allow`, and the tool is still enabled in config as re-read at decision time. Every other path logs a rejection and exits with nothing on stdout, which Claude Code treats as no decision.

## Cowork support

Cowork tasks write no hook events, so a small poller (`bin/zoo-cowork.js`, run under launchd) reads two things instead:

- **Task metadata**: the Claude app's `local-agent-mode-sessions` store, for the task's title, folder, session id, whether it's scheduled, and whether it's archived. The title is shown in the zoo the same way a Claude Code session's name is.
- **Audit logs**: each regular task's `audit.jsonl`. Only the event type, subtype, tool name, and timestamp of each line are kept; a test checks that prompt text, tool arguments, and assistant replies never reach `~/.zoo`. Scheduled tasks are skipped entirely.
- **The VM activity log** (`cowork_vm_node.log`), for chat-only turns that write no audit log at all: only lines matching `[startVM]` or `[vmOneShot]` are read, and only their timestamp and the opaque task handle they name. No other line, and no other field, is stored.

None of this needs the Claude app's Accessibility or Automation permission. It's plain file reads.

## Jump to session

Clicking a monster can bring a window forward: `open -b com.anthropic.claudefordesktop`, a `claude://code/continue` link the Claude app already handles, or (for a session in Terminal.app) one AppleScript call that selects the tab matching the session's own recorded tty. The tty comes from walking `ps` output from the session's pid, not from anything a page or a Cowork task could put in a title or message. The first Terminal jump triggers macOS's own Automation permission prompt for Terminal.app; nothing else asks for a new permission.

## What this does not protect against

Anything already running as your user account. A process with your permissions can write to `~/.zoo/decisions/` directly, and the digest check does not stop it, because such a process could equally well read your SSH keys or run the command itself. zoo raises the bar against remote and cross-origin attacks, not against local code you've already executed.

A compromised or malicious Claude Code, or a compromised Claude desktop app. zoo trusts the hook payloads and the app data it reads. If the thing generating them is lying about what it intends to run or show, the digest and the field filtering only prove that the lie you approved, or the summary you saw, is the lie or summary that was actually there.

Tools outside `matcher_scope.enabled_tools`. Those get a read-only card and must be answered in the terminal. This is deliberate, but it means the popover is not a complete replacement for the terminal prompt.

Requests that never reach zoo at all. Sandboxed network requests do not fire `PermissionRequest`, and commands Claude Code treats as harmless never prompt in the first place.

Headless and background sessions. Per Claude Code's own behaviour these auto-deny when no hook answers. With the app running their prompts can be answered from the popover instead, which changes an auto-deny into a decision you make, so consider whether that's what you want before installing.

The Claude desktop app's session store and Cowork's logs. These are undocumented, internal files the app happens to write today. zoo reads them defensively (missing files, malformed JSON, and unexpected shapes are all handled as "nothing to show"), but a Claude app update can rename or restructure them without notice, silently turning a feature off rather than exposing anything.

## Escalation

If `escalate_minutes` is set, a session blocked that long while the machine has been idle can send one notice to an external webhook, through Hermes, to iMessage. The URL and secret live in `~/.zoo/hermes.json`, outside the repository, and the feature does nothing without that file. The request is signed with an HMAC over its timestamp and body, so a captured request can't be replayed. The notice names the session's folder, how long it's been waiting, and which tool it wants — never the chat title (which can name what you're working on), the command, or any file contents. Delivery through Hermes to iMessage passes through Photon's cloud service if that's the delivery channel you've configured; that's a property of your own Hermes setup, not something zoo controls. zoo itself never sends a message to anyone.

## The panel stays open

Since the popover no longer closes when you click away, a permission card can sit on screen after you've stepped away from the desk, visible to anyone who can see your monitor, until you close it or answer it. If that's not what you want on a shared or unattended machine, keep `matcher_scope.enabled_tools` narrow, or quit the app when you step away.

## Reporting a vulnerability

Open a private security advisory through this repository's Security tab rather than a public issue.

This is a personal project maintained by one person, with no service level attached. Expect a considered reply, not a fast one.

## Scope

In scope: anything that lets a remote page, another origin, or a non-privileged local process cause an approval you did not make, see a request you were not shown, or read more of your Cowork or Claude app data than the field lists above.

Out of scope: attacks requiring code already running as your user, physical access to an unlocked machine, and social engineering of the person clicking Allow.
