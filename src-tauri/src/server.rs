// Port of bin/zoo-serve.js: the same HTTP API on 127.0.0.1, with every guard it
// had. test/integration.js runs its full suite against this binary (ZOO_SERVE_BIN)
// as well as the Node server, so the two are held to one behaviour.
//
// Anything that can write to ~/.zoo/decisions can approve a shell command, so:
// Host must be 127.0.0.1/localhost on our port (no DNS rebinding); every API call
// carries a per-process token the page embeds (a cross-origin page can't read it,
// and a custom header forces a preflight we never answer); writes need an allowed
// Origin and a small JSON body; decisions are checked against the request's digest
// and written create-exclusive; the zoo directories must be 0700 and ours.

use crate::jump;
use crate::zoo::{self, Config, Dirs};
use serde_json::{json, Map, Value};
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tiny_http::{Header, Request, Response};

mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}
pub use assets::FACES;

const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_REASON_UTF16: usize = 500;
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; \
                   connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const POSES: [&str; 6] = ["standing", "working", "blocked", "dancing", "errored", "sleeping"];

pub struct Server {
    dirs: Dirs,
    port: u16,
    token: String,
    // markSeen reads the directory it writes to; one at a time, as in single-threaded Node.
    seen_lock: Mutex<()>,
    // The menu bar app's popover sizing, set only by the app (see on_popover_height).
    popover_height: OnceLock<Box<dyn Fn(f64) + Send + Sync>>,
}

pub fn port() -> u16 {
    std::env::var("ZOO_PORT").ok().and_then(|p| p.parse().ok()).filter(|p| *p > 0).unwrap_or(4790)
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).expect("/dev/urandom");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn permission_problem(dir: &Path) -> Option<String> {
    let d = dir.display();
    let Ok(st) = std::fs::metadata(dir) else { return Some(format!("{d} does not exist")) };
    if !st.is_dir() {
        return Some(format!("{d} is not a directory"));
    }
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    if st.uid() != uid {
        return Some(format!("{d} is owned by uid {}, not you (uid {uid})", st.uid()));
    }
    let mode = st.mode() & 0o777;
    if mode != 0o700 {
        return Some(format!("{d} has mode {mode:03o}, expected 700"));
    }
    None
}

type Reply = (u16, Vec<u8>, Vec<(&'static str, String)>);

fn json_reply(status: u16, body: &Value) -> Reply {
    (status, serde_json::to_vec(body).unwrap(), vec![("Content-Type", "application/json".into())])
}

fn error(status: u16, message: &str) -> Reply {
    json_reply(status, &json!({ "error": message }))
}

fn header<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The path part of the request target, dot segments resolved the way WHATWG URL
/// parsing (Node's `new URL`) resolves them, including %2e spellings.
fn normalize_path(target: &str) -> String {
    let mut path = target;
    if let Some(rest) = path.strip_prefix("http://").or_else(|| path.strip_prefix("https://")) {
        path = rest.find('/').map_or("/", |i| &rest[i..]);
    }
    let path = path.split(['?', '#']).next().unwrap_or("").replace('\\', "/");
    let is_dot = |s: &str| s == "." || s.eq_ignore_ascii_case("%2e");
    let is_dotdot = |s: &str| {
        let l = s.to_ascii_lowercase();
        matches!(l.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
    };
    let mut out: Vec<&str> = Vec::new();
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    for (i, seg) in segments.iter().enumerate() {
        let last = i + 1 == segments.len();
        if is_dotdot(seg) {
            out.pop();
            if last {
                out.push("");
            }
        } else if is_dot(seg) {
            if last {
                out.push("");
            }
        } else {
            out.push(seg);
        }
    }
    format!("/{}", out.join("/"))
}

/// `/monsters/<species>/<pose>[_<colorway>].png` -> (species, file stem).
fn art_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/monsters/")?;
    let (species, file) = rest.split_once('/')?;
    let stem = file.strip_suffix(".png")?;
    let species_ok = !species.is_empty() && species.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let (pose, suffix) = stem.split_once('_').map_or((stem, None), |(p, s)| (p, Some(s)));
    let stem_ok = POSES.contains(&pose) && suffix.map_or(true, |s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase()));
    (species_ok && stem_ok).then_some((species, stem))
}

/// A UTF-16-unit prefix, as JS `slice` would take it (never splitting a pair).
fn utf16_prefix(s: &str, units: usize) -> String {
    let mut n = 0;
    s.chars().take_while(|c| { n += c.len_utf16(); n <= units }).collect()
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o700).open(path)?.write_all(bytes)
}

fn append_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).create(true).mode(0o700).open(path)?.write_all(bytes)
}

impl Server {
    pub fn new(dirs: Dirs, port: u16) -> Server {
        Server { dirs, port, token: random_token(), seen_lock: Mutex::new(()), popover_height: OnceLock::new() }
    }

    /// The menu bar app sizes its popover to the page: the page POSTs its content height
    /// to /popover-height and this callback gets it. Without one (--serve-only, like
    /// bin/zoo-serve.js) that route is a 404.
    pub fn on_popover_height(&self, callback: impl Fn(f64) + Send + Sync + 'static) {
        let _ = self.popover_height.set(Box::new(callback));
    }

    fn set_popover_height(&self, body: Map<String, Value>) -> Reply {
        let Some(callback) = self.popover_height.get() else { return error(404, "not found") };
        let Some(height) = body.get("height").and_then(Value::as_f64).filter(|h| h.is_finite() && *h > 0.0 && *h <= 10_000.0) else {
            return error(400, "bad height");
        };
        callback(height);
        json_reply(200, &json!({ "ok": true }))
    }

    /// Creates the zoo directories and refuses to run unless they're private.
    pub fn prepare(&self) -> Result<(), String> {
        let d = &self.dirs;
        for dir in [&d.zoo, &d.sessions, &d.requests, &d.decisions, &d.seen] {
            if !dir.exists() {
                std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| e.to_string())?;
            }
        }
        match self.security_problem() {
            Some(p) => Err(p),
            None => Ok(()),
        }
    }

    fn security_problem(&self) -> Option<String> {
        let d = &self.dirs;
        permission_problem(&d.zoo).or_else(|| permission_problem(&d.requests)).or_else(|| permission_problem(&d.decisions))
    }

    fn config(&self) -> Config {
        Config::load(&self.dirs)
    }

    fn allowed_host(&self, host: &str) -> bool {
        host == format!("127.0.0.1:{}", self.port) || host == format!("localhost:{}", self.port)
    }

    fn allowed_origin(&self, origin: &str) -> bool {
        origin == format!("http://127.0.0.1:{}", self.port) || origin == format!("http://localhost:{}", self.port)
    }

    /// Binds 127.0.0.1:<port>. Separate from serving so the app can open its popover
    /// knowing the page is reachable.
    pub fn bind(&self) -> Result<Arc<tiny_http::Server>, String> {
        let http = tiny_http::Server::http(("127.0.0.1", self.port)).map_err(|e| format!("port {}: {e}", self.port))?;
        println!("zoo viewer at http://127.0.0.1:{}", self.port);
        Ok(Arc::new(http))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Serves forever, a few requests at a time.
    pub fn serve(self: Arc<Self>, http: Arc<tiny_http::Server>) {
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let (http, me) = (http.clone(), self.clone());
                std::thread::spawn(move || {
                    while let Ok(req) = http.recv() {
                        me.handle(req);
                    }
                })
            })
            .collect();
        for w in workers {
            let _ = w.join();
        }
    }

    fn handle(&self, mut req: Request) {
        let (status, body, headers) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.route(&mut req)))
            .unwrap_or_else(|_| error(500, "internal error"));
        let mut resp = Response::from_data(body).with_status_code(status);
        let mut all = vec![("Cache-Control", "no-store".to_string()), ("X-Content-Type-Options", "nosniff".to_string())];
        // A request refused before its body was read leaves that body on a kept-alive
        // connection, and tiny_http would parse it as the start of the next request.
        // Drain it; past a cap, close the connection instead.
        let cap = 1 << 20;
        if std::io::copy(&mut req.as_reader().take(cap), &mut std::io::sink()).map_or(true, |n| n >= cap) {
            all.push(("Connection", "close".to_string()));
        }
        for (k, v) in headers {
            all.retain(|(ek, _)| *ek != k);
            all.push((k, v));
        }
        for (k, v) in all {
            resp.add_header(Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
        }
        let _ = req.respond(resp);
    }

    fn route(&self, req: &mut Request) -> Reply {
        if !self.allowed_host(header(req, "host").unwrap_or("")) {
            return error(403, "bad host");
        }
        let path = normalize_path(req.url());
        let get = *req.method() == tiny_http::Method::Get;
        let post = *req.method() == tiny_http::Method::Post;

        if get && path == "/" {
            return self.index();
        }
        if get {
            if let Some((species, stem)) = art_path(&path) {
                return art(species, stem);
            }
        }
        if !timing_safe_eq(header(req, "x-zoo-token").unwrap_or("").as_bytes(), self.token.as_bytes()) {
            return error(403, "bad token: the zoo server restarted, reload the page");
        }
        match (get, post, path.as_str()) {
            (true, _, "/state") => {
                // Any open, token-bearing viewer counts, hidden ones included.
                self.touch_heartbeat();
                json_reply(200, &Value::Array(zoo::read_sessions(&self.dirs, &self.config()).into_iter().map(Value::Object).collect()))
            }
            (true, _, "/requests") => {
                json_reply(200, &Value::Array(zoo::read_requests(&self.dirs, &self.config()).into_iter().map(Value::Object).collect()))
            }
            (_, true, "/decision") => self.json_post(req, |me, body| me.decide(body)),
            (_, true, "/seen") => self.json_post(req, |me, body| me.mark_seen(body)),
            (_, true, "/jump") => self.json_post(req, |me, body| me.jump(body)),
            (_, true, "/popover-height") => self.json_post(req, |me, body| me.set_popover_height(body)),
            _ => error(404, "not found"),
        }
    }

    fn index(&self) -> Reply {
        let html = match std::env::var_os("ZOO_UI_DIR") {
            Some(dir) => match std::fs::read_to_string(Path::new(&dir).join("index.html")) {
                Ok(h) => h,
                Err(_) => return (500, b"Could not read ui/index.html".to_vec(), vec![("Content-Type", "text/plain; charset=utf-8".into())]),
            },
            None => assets::INDEX_HTML.to_string(),
        };
        (200, html.replacen("__ZOO_TOKEN__", &self.token, 1).into_bytes(), vec![
            ("Content-Type", "text/html; charset=utf-8".into()),
            ("Content-Security-Policy", CSP.into()),
            ("X-Frame-Options", "DENY".into()),
            ("Referrer-Policy", "no-referrer".into()),
        ])
    }

    pub fn touch_heartbeat(&self) {
        let _ = write_private(&self.dirs.heartbeat, zoo::iso(zoo::now_ms()).unwrap_or_default().as_bytes());
    }

    fn json_post(&self, req: &mut Request, handler: impl Fn(&Self, Map<String, Value>) -> Reply) -> Reply {
        if !self.allowed_origin(header(req, "origin").unwrap_or("")) {
            return error(403, "bad origin");
        }
        if !header(req, "content-type").unwrap_or("").starts_with("application/json") {
            return error(415, "expected application/json");
        }
        let mut raw = Vec::new();
        if req.as_reader().take(MAX_BODY_BYTES as u64 + 1).read_to_end(&mut raw).is_err() {
            return error(413, "body too large");
        }
        if raw.len() > MAX_BODY_BYTES {
            return error(413, "body too large");
        }
        match serde_json::from_str::<Value>(&String::from_utf8_lossy(&raw)) {
            Ok(Value::Object(m)) => handler(self, m),
            Ok(_) => handler(self, Map::new()),
            Err(_) => error(400, "body is not JSON"),
        }
    }

    fn decide(&self, body: Map<String, Value>) -> Reply {
        if let Some(p) = self.security_problem() {
            return error(500, &format!("refusing to write decisions: {p}"));
        }
        let Some(id) = body.get("request_id").and_then(Value::as_str).filter(|id| zoo::is_request_id(id)) else {
            return error(400, "bad request_id");
        };
        let behavior = body.get("behavior").and_then(Value::as_str).unwrap_or("");
        if !["allow", "deny", "defer"].contains(&behavior) {
            return error(400, "bad behavior");
        }
        let rec = zoo::read_object(&self.dirs.requests.join(format!("{id}.json")));
        let Some(rec) = rec.filter(|r| {
            r.get("request_id").and_then(Value::as_str) == Some(id)
                && r.get("mode").and_then(Value::as_str) == Some("awaiting")
                && zoo::pid_alive(r.get("pid"))
        }) else {
            return error(409, "that request has already closed (answered, timed out, or cancelled)");
        };
        let digest = rec.get("digest").and_then(Value::as_str).unwrap_or("");
        if digest != zoo::request_digest(rec.get("tool_name"), rec.get("tool_input")) {
            return error(409, "the request file was modified after it was written; refusing");
        }
        if body.get("digest").and_then(Value::as_str) != Some(digest) {
            return error(409, "what the page showed does not match what is pending; reload");
        }
        if behavior != "defer" && !self.config().allow_enabled(rec.get("tool_name")) {
            let tool = match rec.get("tool_name") { Some(Value::String(s)) => s.clone(), Some(v) => v.to_string(), None => "undefined".into() };
            return error(403, &format!("{tool} is not enabled for approval from the viewer"));
        }

        let mut decision = Map::new();
        decision.insert("request_id".into(), id.into());
        decision.insert("behavior".into(), behavior.into());
        decision.insert("digest".into(), digest.into());
        decision.insert("ts".into(), zoo::iso(zoo::now_ms()).unwrap_or_default().into());
        decision.insert("source".into(), "zoo-app".into());
        if behavior == "deny" {
            let reason = match body.get("reason") {
                None => String::new(),
                Some(Value::String(s)) => utf16_prefix(s, MAX_REASON_UTF16),
                Some(_) => return error(400, "bad reason"),
            };
            decision.insert("reason".into(), reason.into());
        }

        // Create-exclusive: the first decision for a request wins; a second click can't overwrite it.
        let file = self.dirs.decisions.join(format!("{id}.json"));
        let tmp = self.dirs.decisions.join(format!("{id}.json.{}.{}.tmp", std::process::id(), zoo::now_ms() as u64));
        let written = write_private(&tmp, &serde_json::to_vec(&Value::Object(decision)).unwrap())
            .and_then(|_| std::fs::hard_link(&tmp, &file));
        let _ = std::fs::remove_file(&tmp);
        match written {
            Ok(()) => json_reply(200, &json!({ "ok": true })),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => error(409, "that request already has a decision"),
            Err(_) => error(500, "internal error"),
        }
    }

    /// Reading a session in its own window fires no hook, so clicking a finished
    /// monster says you've seen it. The mark names the turn it covers (finished_at).
    /// Opens the window a session lives in (jump.rs). The page names the session;
    /// everything opened is derived here from validated ids. The opening runs on its
    /// own thread: osascript can wait on a macOS permission prompt, and a worker
    /// shouldn't. ZOO_JUMP_DRY_RUN=1 (the tests) reports the plan instead.
    fn jump(&self, body: Map<String, Value>) -> Reply {
        let Some(id) = body.get("session_id").and_then(Value::as_str).filter(|id| zoo::is_session_id(id)) else {
            return error(400, "bad session_id");
        };
        let session = zoo::read_object(&self.dirs.sessions.join(format!("{id}.json")));
        let Some(session) = session.filter(|s| s.get("session_id").and_then(Value::as_str) == Some(id)) else {
            return error(404, "no such session");
        };
        let home = self.dirs.zoo.parent().unwrap_or(&self.dirs.zoo);
        let action = match jump::plan(&session, home, &jump::ps_info) {
            Ok(action) => action,
            Err(refusal) => return error(refusal.status, refusal.error),
        };
        let plan = action.to_json();
        if std::env::var("ZOO_JUMP_DRY_RUN").as_deref() == Ok("1") {
            return json_reply(200, &json!({ "ok": true, "kind": plan["kind"], "dry_run": plan }));
        }
        std::thread::spawn(move || jump::perform(&action));
        json_reply(200, &json!({ "ok": true, "kind": plan["kind"] }))
    }

    fn mark_seen(&self, body: Map<String, Value>) -> Reply {
        let Some(id) = body.get("session_id").and_then(Value::as_str).filter(|id| zoo::is_session_id(id)) else {
            return error(400, "bad session_id");
        };
        let Some(finished_at) = body.get("finished_at").and_then(Value::as_str).filter(|f| !f.is_empty()) else {
            return error(400, "bad finished_at");
        };
        let _guard = self.seen_lock.lock().unwrap_or_else(|e| e.into_inner());
        let now = zoo::now_ms();
        let file = zoo::read_object(&self.dirs.sessions.join(format!("{id}.json")));
        let s = file.map(|f| zoo::apply_unread_check(f, now, self.config().unread_after_seconds()));
        let current = s.as_ref().filter(|s| {
            matches!(s.get("state").and_then(Value::as_str), Some("done" | "unread"))
                && s.get("finished_at").and_then(Value::as_str) == Some(finished_at)
        });
        let Some(s) = current else {
            return error(409, "that session has moved on since the page showed it");
        };
        let ts = zoo::iso(now).unwrap_or_default();
        let mark = json!({ "session_id": id, "finished_at": finished_at, "ts": ts });
        let path = self.dirs.seen.join(format!("{id}.json"));
        let tmp = self.dirs.seen.join(format!("{id}.json.{}.{}.tmp", std::process::id(), now as u64));
        if write_private(&tmp, &serde_json::to_vec(&mark).unwrap()).and_then(|_| std::fs::rename(&tmp, &path)).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return error(500, "internal error");
        }
        let field = |k: &str| s.get(k).filter(|v| zoo_truthy(v)).cloned().unwrap_or(Value::Null);
        let event = json!({
            "ts": ts,
            "vendor": s.get("vendor").filter(|v| zoo_truthy(v)).cloned().unwrap_or_else(|| "claude-code".into()),
            "session_id": id,
            "event": "ZooSeen",
            "cwd": field("cwd"),
            "project_dir": field("project_dir"),
            "client": field("client"),
            "client_pid": field("client_pid"),
            "agent_id": null,
            "agent_type": null,
            "data": { "finished_at": finished_at, "was": s["state"] },
        });
        let mut line = serde_json::to_vec(&event).unwrap();
        line.push(b'\n');
        if append_private(&self.dirs.events, &line).is_err() {
            return error(500, "internal error");
        }
        // Marks outlive their session's file once it's archived; drop those.
        if let Ok(entries) = std::fs::read_dir(&self.dirs.seen) {
            for e in entries.flatten() {
                let name = e.file_name();
                if name.to_str().is_some_and(|n| n.ends_with(".json")) && !self.dirs.sessions.join(&name).exists() {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        json_reply(200, &json!({ "ok": true }))
    }
}

fn zoo_truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false)) && v != "" && v.as_f64() != Some(0.0)
}

fn art(species: &str, stem: &str) -> Reply {
    let bytes = match std::env::var_os("ZOO_UI_DIR") {
        Some(dir) => std::fs::read(Path::new(&dir).join("monsters").join(species).join(format!("{stem}.png"))).ok(),
        None => assets::ART.iter().find(|(s, f, _)| *s == species && *f == stem).map(|(_, _, b)| b.to_vec()),
    };
    match bytes {
        Some(png) => (200, png, vec![("Content-Type", "image/png".into()), ("Cache-Control", "no-cache".into())]),
        None => error(404, "not found"),
    }
}

/// `zoo --serve-only`: the server without the tray, as bin/zoo-serve.js ran.
pub fn serve_only() -> ! {
    let server = Arc::new(Server::new(Dirs::from_home(), port()));
    if let Err(problem) = server.prepare() {
        eprintln!(
            "zoo-serve: refusing to start: {problem}.\nAnything that can write to ~/.zoo/decisions can approve a shell \
             command, so the zoo directories must be private to you. Fix with: chmod 700 ~/.zoo ~/.zoo/requests ~/.zoo/decisions"
        );
        std::process::exit(1);
    }
    match server.bind() {
        Ok(http) => server.serve(http),
        Err(e) => {
            eprintln!("zoo-serve: {e}");
            std::process::exit(1);
        }
    }
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_normalize_like_node() {
        assert_eq!(normalize_path("/state?x=1"), "/state");
        assert_eq!(normalize_path("/monsters/scarf/../../index.html"), "/index.html");
        assert_eq!(normalize_path("/monsters/%2e%2e/%2E%2e/bin/zoo-serve.js"), "/bin/zoo-serve.js");
        assert_eq!(normalize_path("/monsters/scarf/blocked_../../SPEC.md"), "/monsters/scarf/SPEC.md");
        assert_eq!(normalize_path("/a/.."), "/");
        assert_eq!(normalize_path("http://evil.example/state"), "/state");
    }

    #[test]
    fn only_pose_images_are_art() {
        assert_eq!(art_path("/monsters/scarf/blocked.png"), Some(("scarf", "blocked")));
        assert_eq!(art_path("/monsters/scarf/sleeping_rose.png"), Some(("scarf", "sleeping_rose")));
        for bad in ["/monsters/scarf/other.png", "/monsters/scarf/blocked_Rose.png", "/monsters/scarf/blocked_.png",
                    "/monsters/scarf/SPEC.md", "/monsters/Scarf/blocked.png", "/monsters/scarf/x/blocked.png"] {
            assert_eq!(art_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn reasons_are_cut_by_utf16_units() {
        assert_eq!(utf16_prefix("abc", 2), "ab");
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
    }
}
