// Reading ~/.zoo the way bin/zoo-serve.js and lib/*.js do. Everything here is a
// port of that JavaScript and has to agree with it: the hook script still writes
// every file, and a decision is only honoured if this side's request digest matches
// the hook's byte for byte. Values stay as serde_json::Value so session fields the
// hook adds later pass through untouched, as they did with the JS spread.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct Dirs {
    pub zoo: PathBuf,
    pub sessions: PathBuf,
    pub requests: PathBuf,
    pub decisions: PathBuf,
    pub seen: PathBuf,
    pub config: PathBuf,
    pub heartbeat: PathBuf,
    pub events: PathBuf,
}

impl Dirs {
    pub fn from_home() -> Dirs {
        let home = std::env::var_os("HOME").map(PathBuf::from).expect("HOME is set");
        let zoo = home.join(".zoo");
        Dirs {
            sessions: zoo.join("sessions"),
            requests: zoo.join("requests"),
            decisions: zoo.join("decisions"),
            seen: zoo.join("seen"),
            config: zoo.join("config.json"),
            heartbeat: zoo.join("viewer-heartbeat"),
            events: zoo.join("events.jsonl"),
            zoo,
        }
    }
}

pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub fn read_object(path: &Path) -> Option<Map<String, Value>> {
    match read_json(path)? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

// ---- JavaScript semantics the ported code relies on ----------------------------

/// JS `Number(value)`.
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                return 0.0;
            }
            match t {
                "Infinity" | "+Infinity" => return f64::INFINITY,
                "-Infinity" => return f64::NEG_INFINITY,
                _ => {}
            }
            if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                return u64::from_str_radix(hex, 16).map(|n| n as f64).unwrap_or(f64::NAN);
            }
            // Rust also accepts "inf" and "nan"; JS doesn't.
            if t.bytes().any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E') {
                return f64::NAN;
            }
            t.parse().unwrap_or(f64::NAN)
        }
        Some(_) => f64::NAN,
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JS `Date.parse(value)` for the ISO timestamps the hook writes. Non-strings are NaN.
pub fn date_parse(v: Option<&Value>) -> f64 {
    let Some(Value::String(s)) = v else { return f64::NAN };
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt.timestamp_millis() as f64;
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64;
    }
    f64::NAN
}

/// JS `new Date(value).getTime()`: numbers are epoch ms, null is 0.
fn date_time(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().map_or(f64::NAN, f64::trunc),
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        other => date_parse(other),
    }
}

/// JS `Date.prototype.toISOString`, e.g. 2026-09-11T08:21:24.267Z.
pub fn iso(ms: f64) -> Option<String> {
    let dt = chrono::DateTime::from_timestamp_millis(ms.trunc() as i64)?;
    Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

pub fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

fn str_of<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str)
}

// ---- lib/config.js -------------------------------------------------------------

pub struct Config(Map<String, Value>);

impl Config {
    /// mergeConfig: file values over defaults, matcher_scope merged one level down.
    pub fn load(dirs: &Dirs) -> Config {
        let mut m: Map<String, Value> = serde_json::from_str(
            r#"{"stale_hours":6,"unread_after_seconds":60,"spawned_hide_minutes":10,
                "approve_timeout_seconds":90,"viewer_heartbeat_seconds":90,"linger_max_seconds":3480,
                "matcher_scope":{"enabled_tools":["Bash","Write","Edit","MultiEdit"]}}"#,
        )
        .unwrap();
        let file = read_object(&dirs.config).unwrap_or_default();
        let mut scope = m["matcher_scope"].as_object().cloned().unwrap();
        if let Some(Value::Object(s)) = file.get("matcher_scope") {
            scope.extend(s.clone());
        }
        m.extend(file);
        m.insert("matcher_scope".into(), Value::Object(scope));
        Config(m)
    }

    fn positive(&self, key: &str, fallback: f64) -> f64 {
        let n = js_number(self.0.get(key));
        if n.is_finite() && n > 0.0 { n } else { fallback }
    }

    /// Used raw, as the JS comparison `ageHours > config.stale_hours` does.
    pub fn stale_hours(&self) -> f64 {
        js_number(self.0.get("stale_hours"))
    }

    pub fn unread_after_seconds(&self) -> f64 {
        self.positive("unread_after_seconds", 60.0)
    }

    pub fn spawned_hide_minutes(&self) -> f64 {
        let n = js_number(self.0.get("spawned_hide_minutes"));
        if n.is_finite() && n >= 0.0 { n } else { 10.0 }
    }

    pub fn approve_timeout_seconds(&self) -> f64 {
        let n = js_number(self.0.get("approve_timeout_seconds"));
        if !n.is_finite() { 90.0 } else { n.clamp(5.0, 590.0) }
    }

    /// isAllowEnabled: tool_name is in matcher_scope.enabled_tools.
    pub fn allow_enabled(&self, tool_name: Option<&Value>) -> bool {
        let tool = tool_name.unwrap_or(&Value::Null);
        self.0["matcher_scope"]
            .get("enabled_tools")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|t| t == tool))
    }
}

// ---- lib/liveness.js -----------------------------------------------------------

/// A JS integer > 0 that fits a pid.
fn as_pid(v: Option<&Value>) -> Option<i32> {
    let f = v?.as_f64()?;
    (f.fract() == 0.0 && f > 0.0 && f <= i32::MAX as f64).then_some(f as i32)
}

/// A process with this pid exists; EPERM (someone else's) still counts as alive.
pub fn pid_alive(v: Option<&Value>) -> bool {
    let Some(pid) = as_pid(v) else { return false };
    // SAFETY: kill with signal 0 only checks that the process exists.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn is_client_gone(s: &Map<String, Value>) -> bool {
    if str_of(s, "state") == Some("gone") {
        return false;
    }
    let pid = s.get("client_pid");
    as_pid(pid).is_some() && !pid_alive(pid)
}

// ---- lib/reducer.js: the time-based states -------------------------------------

pub fn is_seen(s: &Map<String, Value>) -> bool {
    truthy(s.get("finished_at")) && s.get("seen_for") == s.get("finished_at")
}

pub fn apply_seen(mut s: Map<String, Value>, mark: Option<&Map<String, Value>>) -> Map<String, Value> {
    let Some(mark) = mark else { return s };
    if !truthy(s.get("finished_at")) || mark.get("finished_at") != s.get("finished_at") {
        return s;
    }
    let finished = s["finished_at"].clone();
    s.insert("seen_for".into(), finished);
    if str_of(&s, "state") == Some("unread") {
        s.insert("state".into(), "done".into());
    }
    s
}

pub fn apply_unread_check(mut s: Map<String, Value>, now: f64, unread_seconds: f64) -> Map<String, Value> {
    if str_of(&s, "state") != Some("done") || is_seen(&s) {
        return s;
    }
    let since = date_parse(s.get("since"));
    if since.is_nan() {
        return s;
    }
    let due = since + unread_seconds * 1000.0;
    if now < due {
        return s;
    }
    s.insert("state".into(), "unread".into());
    s.insert("since".into(), iso(due).map_or(Value::Null, Value::String));
    s
}

pub fn apply_stale_check(mut s: Map<String, Value>, now: f64, stale_hours: f64) -> Map<String, Value> {
    let state = s.get("state").cloned().unwrap_or(Value::Null);
    if state == "gone" || state == "stale" {
        return s;
    }
    let updated = date_time(s.get("updated_at"));
    if updated.is_nan() {
        return s;
    }
    if (now - updated) / 3_600_000.0 > stale_hours {
        s.insert("state".into(), "stale".into());
        s.insert("stale_from".into(), state);
        s.insert("since".into(), iso(now).map_or(Value::Null, Value::String));
    }
    s
}

pub fn is_forgotten_spawn(s: &Map<String, Value>, now: f64, hide_minutes: f64) -> bool {
    if hide_minutes == 0.0 || hide_minutes.is_nan() {
        return false;
    }
    match str_of(s, "state") {
        Some("stale") => str_of(s, "stale_from") == Some("spawned"),
        Some("spawned") => {
            let since = date_parse(s.get("since"));
            !since.is_nan() && now - since > hide_minutes * 60_000.0
        }
        _ => false,
    }
}

/// readSessions in zoo-serve.js: every live session with its time-based state derived.
pub fn read_sessions(dirs: &Dirs, config: &Config) -> Vec<Map<String, Value>> {
    let Ok(entries) = std::fs::read_dir(&dirs.sessions) else { return Vec::new() };
    let now = now_ms();
    let (unread, stale, hide) = (config.unread_after_seconds(), config.stale_hours(), config.spawned_hide_minutes());
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|n| n.ends_with(".json")) else { continue };
        let Some(s) = read_object(&dirs.sessions.join(name)) else { continue };
        if is_client_gone(&s) || is_forgotten_spawn(&s, now, hide) {
            continue;
        }
        let mark = read_object(&dirs.seen.join(name));
        out.push(apply_stale_check(apply_unread_check(apply_seen(s, mark.as_ref()), now, unread), now, stale));
    }
    out
}

// ---- lib/permission.js: the request digest -------------------------------------

/// JS `Number.prototype.toString` (what JSON.stringify prints). JSON.parse turns
/// every number into a double, so integers past 2^53 round exactly as they do there.
pub fn js_number_string(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let sci = format!("{:e}", x.abs()); // shortest round-trip digits, e.g. 1.2345e-7
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let mant = if k == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        format!("{mant}e{sign}{}", e.abs())
    };
    if x < 0.0 { format!("-{body}") } else { body }
}

/// JS `JSON.stringify(string)`.
fn js_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `canonical` in lib/permission.js: JSON with object keys sorted the way JS's
/// default sort does, by UTF-16 code units.
pub fn canonical(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number_string(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => js_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_string(k, out);
                out.push(':');
                canonical(&m[k], out);
            }
            out.push('}');
        }
    }
}

pub fn request_digest(tool_name: Option<&Value>, tool_input: Option<&Value>) -> String {
    let mut obj = Map::new();
    obj.insert("tool_name".into(), tool_name.cloned().unwrap_or(Value::Null));
    obj.insert("tool_input".into(), tool_input.cloned().unwrap_or(Value::Null));
    let mut text = String::new();
    canonical(&Value::Object(obj), &mut text);
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn is_request_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

pub fn is_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// readRequests in zoo-serve.js: requests whose hook is alive and whose content is
/// untampered, oldest first.
pub fn read_requests(dirs: &Dirs, config: &Config) -> Vec<Map<String, Value>> {
    let Ok(entries) = std::fs::read_dir(&dirs.requests) else { return Vec::new() };
    let timeout_ms = config.approve_timeout_seconds() * 1000.0;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
        if !is_request_id(id) {
            continue;
        }
        let Some(mut rec) = read_object(&entry.path()) else { continue };
        if str_of(&rec, "request_id") != Some(id) {
            continue;
        }
        if str_of(&rec, "digest") != Some(&request_digest(rec.get("tool_name"), rec.get("tool_input"))) {
            continue;
        }
        if !pid_alive(rec.get("pid")) {
            continue;
        }
        // zoo-serve.js threw on a bad timestamp and failed the whole list; skip just this one.
        let Some(expires) = iso(date_parse(rec.get("ts")) + timeout_ms) else { continue };
        let allow = str_of(&rec, "mode") == Some("awaiting") && config.allow_enabled(rec.get("tool_name"));
        rec.insert("allow_enabled".into(), Value::Bool(allow));
        rec.insert("expires_at".into(), Value::String(expires));
        out.push(rec);
    }
    let ts = |r: &Map<String, Value>| match r.get("ts") {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => "undefined".into(),
    };
    out.sort_by_key(|r| ts(r));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        for (x, js) in [
            (0.0, "0"), (-0.0, "0"), (1.0, "1"), (-12.5, "-12.5"), (0.1, "0.1"), (1e21, "1e+21"),
            (1e20, "100000000000000000000"), (123456789012345680000.0, "123456789012345680000"),
            (1.5e-7, "1.5e-7"), (0.000001, "0.000001"), (1e-7, "1e-7"), (9007199254740993.0, "9007199254740992"),
            (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (2.5e25, "2.5e+25"),
        ] {
            assert_eq!(js_number_string(x), js, "{x}");
        }
    }

    #[test]
    fn keys_sort_by_utf16_units() {
        let v: Value = serde_json::from_str(r#"{"ﬁ":1,"😀":2,"b":3,"A":4}"#).unwrap();
        let mut s = String::new();
        canonical(&v, &mut s);
        assert_eq!(s, "{\"A\":4,\"b\":3,\"😀\":2,\"ﬁ\":1}");
    }

    #[test]
    fn request_ids_are_lowercase_uuids() {
        assert!(is_request_id("0123abcd-0123-4567-89ab-0123456789ab"));
        assert!(!is_request_id("0123ABCD-0123-4567-89ab-0123456789ab"));
        assert!(!is_request_id("../../x"));
    }
}
