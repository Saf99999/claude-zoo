// Port of lib/jump.js: jump to the window a session lives in. The two must agree;
// test/integration.js runs the same /jump scenarios against both servers.
//
// Desktop-app sessions open with claude://code/continue?session=<local id>, the
// Claude app's own (undocumented) route for an existing session, with the id taken
// from its session store. Terminal sessions: select the Terminal.app tab with the
// session's tty, or activate whichever app hosts it.

use serde_json::{Map, Value};
use std::path::Path;
use std::process::Command;

const DESKTOP_BUNDLE_ID: &str = "com.anthropic.claudefordesktop";
const MAX_ANCESTORS: usize = 15;

#[derive(Debug, PartialEq)]
pub enum Action {
    Desktop { url: String },
    DesktopApp,
    TerminalTab { tty: String, app: String },
    App { app: String },
}

impl Action {
    pub fn to_json(&self) -> Value {
        match self {
            Action::Desktop { url } => serde_json::json!({ "kind": "desktop", "url": url }),
            Action::DesktopApp => serde_json::json!({ "kind": "desktop-app" }),
            Action::TerminalTab { tty, app } => serde_json::json!({ "kind": "terminal-tab", "tty": tty, "app": app }),
            Action::App { app } => serde_json::json!({ "kind": "app", "app": app }),
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub error: &'static str,
}

/// The Claude app's own check on these ids.
pub fn is_local_id(s: &str) -> bool {
    s.strip_prefix("local_")
        .is_some_and(|r| (1..=64).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn is_tty(s: &str) -> bool {
    s.strip_prefix("ttys").is_some_and(|n| (1..=4).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
}

fn subdirs(dir: &Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .map(|it| it.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// (local id, archived) for the desktop session whose cliSessionId is ours.
pub fn desktop_session(home: &Path, cli_session_id: &str) -> Option<(String, bool)> {
    store_session(&home.join("Library/Application Support/Claude/claude-code-sessions"), cli_session_id)
}

/// The same lookup in the Claude app's Cowork store.
pub fn cowork_session(home: &Path, cli_session_id: &str) -> Option<(String, bool)> {
    store_session(&home.join("Library/Application Support/Claude/local-agent-mode-sessions"), cli_session_id)
}

fn store_session(root: &Path, cli_session_id: &str) -> Option<(String, bool)> {
    for org in subdirs(root).iter().flat_map(|a| subdirs(a)) {
        let Ok(entries) = std::fs::read_dir(&org) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.starts_with("local_") || !name.ends_with(".json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(entry.path()) else { continue };
            if !raw.contains(cli_session_id) {
                continue;
            }
            let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&raw) else { continue };
            let local = record.get("sessionId").and_then(Value::as_str).unwrap_or("");
            if record.get("cliSessionId").and_then(Value::as_str) == Some(cli_session_id) && is_local_id(local) {
                let archived = matches!(record.get("isArchived"), Some(Value::Bool(true)));
                return Some((local.to_string(), archived));
            }
        }
    }
    None
}

/// One `ps -o ppid=,tty=,comm=` line: (ppid, tty, command).
pub fn parse_ps(line: &str) -> Option<(i32, String, String)> {
    let line = line.trim();
    let (ppid, rest) = line.split_once(char::is_whitespace)?;
    let rest = rest.trim_start();
    let (tty, command) = rest.split_once(char::is_whitespace)?;
    let command = command.trim();
    (!command.is_empty()).then(|| Some((ppid.parse().ok()?, tty.to_string(), command.to_string())))?
}

pub fn ps_info(pid: i32) -> Option<(i32, String, String)> {
    let out = Command::new("/bin/ps").args(["-o", "ppid=,tty=,comm=", "-p", &pid.to_string()]).output().ok()?;
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

/// "/Applications/X.app/Contents/MacOS/X" -> "/Applications/X.app", skipping Claude
/// Code's own claude.app bundle.
pub fn app_bundle(command: &str) -> Option<&str> {
    let end = command.find(".app/Contents/MacOS/")? + ".app".len();
    let bundle = &command[..end];
    (!bundle.ends_with("/claude.app")).then_some(bundle)
}

pub fn plan(session: &Map<String, Value>, home: &Path, ps: &dyn Fn(i32) -> Option<(i32, String, String)>) -> Result<Action, Refusal> {
    let Some(id) = session.get("session_id").and_then(Value::as_str) else {
        return Err(Refusal { status: 404, error: "no such session" });
    };
    // A Cowork heartbeat monster can't be matched to a task: bring the app forward.
    if session.get("client").and_then(Value::as_str) == Some("cowork-heartbeat") {
        return Ok(Action::DesktopApp);
    }
    // Cowork: the "waiting for you" link opens a waiting Cowork session; any other
    // Cowork state just brings the Claude app forward.
    if session.get("vendor").and_then(Value::as_str) == Some("claude-cowork") {
        let Some((local, archived)) = cowork_session(home, id) else {
            return Err(Refusal { status: 409, error: "that Cowork session is no longer in the Claude app" });
        };
        if archived {
            return Err(Refusal { status: 409, error: "that session is archived in the Claude app" });
        }
        if session.get("state").and_then(Value::as_str) == Some("blocked") {
            return Ok(Action::Desktop { url: format!("claude://code/needs-input?session={local}") });
        }
        return Ok(Action::DesktopApp);
    }
    if let Some((local, archived)) = desktop_session(home, id) {
        if archived {
            return Err(Refusal { status: 409, error: "that session is archived in the Claude app" });
        }
        return Ok(Action::Desktop { url: format!("claude://code/continue?session={local}") });
    }
    let pid = session.get("client_pid").and_then(Value::as_f64).filter(|p| p.fract() == 0.0 && *p > 0.0 && *p <= i32::MAX as f64);
    let Some(pid) = pid.map(|p| p as i32) else {
        return Err(Refusal { status: 409, error: "the zoo has no process for this session" });
    };
    let Some((mut next, tty, _)) = ps(pid) else {
        return Err(Refusal { status: 409, error: "that session's process has exited" });
    };
    if !is_tty(&tty) {
        return Err(Refusal { status: 409, error: "that session has no window to open" });
    }
    for _ in 0..MAX_ANCESTORS {
        if next <= 1 {
            break;
        }
        let Some((ppid, _, command)) = ps(next) else { break };
        if let Some(app) = app_bundle(&command) {
            return Ok(if app.ends_with("/Terminal.app") {
                Action::TerminalTab { tty: format!("/dev/{tty}"), app: app.to_string() }
            } else {
                Action::App { app: app.to_string() }
            });
        }
        next = ppid;
    }
    Err(Refusal { status: 409, error: "couldn't find the app that session runs in" })
}

const TERMINAL_TAB_SCRIPT: [&str; 16] = [
    "on run argv",
    "  set wanted to item 1 of argv",
    "  tell application \"Terminal\"",
    "    repeat with w in windows",
    "      repeat with t in tabs of w",
    "        if tty of t is wanted then",
    "          set selected of t to true",
    "          set index of w to 1",
    "          activate",
    "          return \"ok\"",
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end tell",
    "  return \"not found\"",
    "end run",
];

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    Command::new(cmd).args(args).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string())
}

/// Carries out a plan; every value is a separate argv entry, never a shell string.
pub fn perform(action: &Action) {
    match action {
        Action::Desktop { url } => {
            run("/usr/bin/open", &[url]);
            // The link can land in the background (anthropics/claude-code#65610).
            run("/usr/bin/open", &["-b", DESKTOP_BUNDLE_ID]);
        }
        Action::TerminalTab { tty, app } => {
            let mut args: Vec<&str> = TERMINAL_TAB_SCRIPT.iter().flat_map(|l| ["-e", *l]).collect();
            args.push(tty);
            let found = run("/usr/bin/osascript", &args).is_some_and(|out| out.trim() == "ok");
            if !found {
                run("/usr/bin/open", &["-a", app]);
            }
        }
        Action::DesktopApp => {
            run("/usr/bin/open", &["-b", DESKTOP_BUNDLE_ID]);
        }
        Action::App { app } => {
            run("/usr/bin/open", &["-a", app]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &'static [(i32, i32, &'static str, &'static str)]) -> impl Fn(i32) -> Option<(i32, String, String)> {
        move |pid| rows.iter().find(|r| r.0 == pid).map(|r| (r.1, r.2.to_string(), r.3.to_string()))
    }

    fn session(pid: Option<i32>) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("session_id".into(), "cli-1".into());
        if let Some(p) = pid {
            m.insert("client_pid".into(), p.into());
        }
        m
    }

    #[test]
    fn ids_ttys_and_ps_lines() {
        assert!(is_local_id("local_abc-123"));
        assert!(!is_local_id("local_bad;rm"));
        assert!(!is_local_id("local_"));
        assert!(is_tty("ttys003"));
        assert!(!is_tty("??"));
        assert_eq!(
            parse_ps("  123 ttys004 /Applications/Some App.app/Contents/MacOS/Some App\n"),
            Some((123, "ttys004".into(), "/Applications/Some App.app/Contents/MacOS/Some App".into()))
        );
        assert_eq!(parse_ps(""), None);
        assert_eq!(app_bundle("/Applications/Some App.app/Contents/MacOS/Some App"), Some("/Applications/Some App.app"));
        assert_eq!(app_bundle("/x/claude-code/claude.app/Contents/MacOS/claude"), None);
        assert_eq!(app_bundle("-zsh"), None);
    }

    #[test]
    fn terminal_tab_other_app_and_refusals() {
        let home = std::env::temp_dir().join(format!("zoo-jump-rs-{}", std::process::id()));
        let term = table(&[
            (500, 400, "ttys003", "claude"),
            (400, 300, "ttys003", "-zsh"),
            (300, 1, "??", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
        ]);
        assert_eq!(
            plan(&session(Some(500)), &home, &term),
            Ok(Action::TerminalTab { tty: "/dev/ttys003".into(), app: "/System/Applications/Utilities/Terminal.app".into() })
        );
        let ghostty = table(&[(500, 400, "ttys001", "claude"), (400, 1, "??", "/Applications/Ghostty.app/Contents/MacOS/ghostty")]);
        assert_eq!(plan(&session(Some(500)), &home, &ghostty), Ok(Action::App { app: "/Applications/Ghostty.app".into() }));
        assert_eq!(plan(&session(None), &home, &term).unwrap_err().status, 409);
        let headless = table(&[(9, 1, "??", "claude")]);
        assert_eq!(plan(&session(Some(9)), &home, &headless).unwrap_err().error, "that session has no window to open");
    }

    #[test]
    fn cowork_sessions_open_while_waiting_and_otherwise_bring_the_app_forward() {
        let home = std::env::temp_dir().join(format!("zoo-jump-rs-cowork-{}", std::process::id()));
        let dir = home.join("Library/Application Support/Claude/local-agent-mode-sessions/acct/org");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("local_cw1.json"), r#"{"sessionId":"local_cw1","cliSessionId":"cli-1","isArchived":false}"#).unwrap();
        let none = |_| None;
        let mut s = session(None);
        s.insert("vendor".into(), "claude-cowork".into());
        s.insert("state".into(), "blocked".into());
        assert_eq!(plan(&s, &home, &none), Ok(Action::Desktop { url: "claude://code/needs-input?session=local_cw1".into() }));
        s.insert("state".into(), "done".into());
        assert_eq!(plan(&s, &home, &none), Ok(Action::DesktopApp));
        std::fs::remove_file(dir.join("local_cw1.json")).unwrap();
        assert_eq!(plan(&s, &home, &none).unwrap_err().status, 409);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn cowork_heartbeat_monsters_bring_the_app_forward() {
        let home = std::env::temp_dir().join(format!("zoo-jump-rs-hb-{}", std::process::id()));
        let mut s = session(None);
        s.insert("vendor".into(), "claude-cowork".into());
        s.insert("client".into(), "cowork-heartbeat".into());
        s.insert("state".into(), "working".into());
        let none = |_| None;
        assert_eq!(plan(&s, &home, &none), Ok(Action::DesktopApp));
    }

    #[test]
    fn desktop_sessions_are_found_in_the_app_store() {
        let home = std::env::temp_dir().join(format!("zoo-jump-rs-desk-{}", std::process::id()));
        let dir = home.join("Library/Application Support/Claude/claude-code-sessions/acct/org");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("local_abc.json"), r#"{"sessionId":"local_abc","cliSessionId":"cli-1","isArchived":false}"#).unwrap();
        let none = |_| None;
        assert_eq!(plan(&session(None), &home, &none), Ok(Action::Desktop { url: "claude://code/continue?session=local_abc".into() }));
        std::fs::write(dir.join("local_abc.json"), r#"{"sessionId":"local_abc","cliSessionId":"cli-1","isArchived":true}"#).unwrap();
        assert_eq!(plan(&session(None), &home, &none).unwrap_err().status, 409);
        let _ = std::fs::remove_dir_all(&home);
    }
}
