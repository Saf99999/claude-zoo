// The menu bar app: the server from server.rs, two tray icons, and a popover window
// with the viewer page. Either icon opens the same popover, under the icon clicked.
//
// The Code icon shows the worst state across Claude Code sessions (NOTES.md, Phase 4
// tray spike): blocked or errored shows the screaming face, shaking; unread shows the
// grinning face with a red dot, shaking; anything else shows the grinning face, still.
// Next to the face: the first letter of the folder the session is in, plus the blocked
// count when more than one is blocked. A session that has just finished (done, not yet
// dismissed) shows its letter beside the still grin, so done doesn't look like working.
//
// The Cowork icon (NOTES.md, Phase 5: two menu bar icons) is there only while the
// Cowork heartbeat monster is: the dragon awake while working, asleep when done, asleep
// with the dot and shaking when unread. No letter. Only the shaking looks cost CPU, and
// only while something needs you.

use crate::server::{Server, FACES};
use crate::zoo::{self, Config, Dirs};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventMask, NSImage, NSScreen, NSWindow, NSWindowOcclusionState};
use objc2_foundation::{NSData, NSPoint, NSRect, NSSize};
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::os::unix::fs::OpenOptionsExt;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const POPOVER: &str = "popover";
const POPOVER_SIZE: (f64, f64) = (380.0, 560.0);
const GRIP_PT: f64 = 18.0; // the grip bar the page draws across its top when loaded with ?app=1
const ICON_HEIGHT_PT: f64 = 20.0; // Safiyya's pick from the spike, between 18 and 22
const FRAME: Duration = Duration::from_millis(125); // 8 fps shake
// The menu bar's own order. Unlike the page's attention queue, a finished session
// outranks a working one here: it's the one that might want you.
const PRIORITY: [&str; 5] = ["blocked", "errored", "unread", "done", "working"];
const COLORWAYS: [&str; 4] = ["teal", "indigo", "violet", "rose"];

/// What the tray should show. Recomputed every second; applied only on change.
#[derive(Clone, PartialEq, Debug)]
struct View {
    look: &'static str, // "scream" | "unread" | "idle" | "rest" (dragon, done), as named in FACES
    colorway: &'static str, // a scarf colorway, or "dragon"
    title: Option<String>,
}

impl View {
    fn shakes(&self) -> bool {
        matches!(self.look, "scream" | "unread")
    }
}

fn priority(state: &str) -> usize {
    PRIORITY.iter().position(|p| *p == state).unwrap_or(PRIORITY.len())
}

fn state_of(s: &Map<String, Value>) -> &str {
    s.get("state").and_then(Value::as_str).unwrap_or("")
}

/// A Cowork heartbeat monster (lib/cowork-heartbeat.js), drawn as the dragon.
fn is_heartbeat(s: &Map<String, Value>) -> bool {
    s.get("client").and_then(Value::as_str) == Some("cowork-heartbeat")
}

/// "dragon" for a heartbeat monster (one palette). Otherwise the session's own
/// colorway (picked when it started; lib/reducer.js), or for sessions from before
/// that, the old derivation: first byte of monster_seed mod 4. Same as the page.
fn colorway(s: &Map<String, Value>) -> &'static str {
    if is_heartbeat(s) {
        return "dragon";
    }
    if let Some(own) = s.get("colorway").and_then(Value::as_str) {
        if let Some(c) = COLORWAYS.iter().find(|c| **c == own) {
            return c;
        }
    }
    let seed = s.get("monster_seed").and_then(Value::as_str).unwrap_or("");
    seed.get(..2).and_then(|b| u8::from_str_radix(b, 16).ok()).map_or("teal", |b| COLORWAYS[b as usize % 4])
}

/// First letter of the folder the session runs in (not its chat title).
fn folder_letter(s: &Map<String, Value>) -> Option<char> {
    let dir = ["project_dir", "cwd"].iter().find_map(|k| s.get(*k).and_then(Value::as_str).filter(|d| !d.is_empty()))?;
    let name = std::path::Path::new(dir).file_name()?.to_str()?;
    name.chars().find(|c| c.is_alphanumeric()).map(|c| c.to_uppercase().next().unwrap_or(c))
}

/// A done session clicked in the popover has been seen: nothing to point at.
fn wants_attention(s: &Map<String, Value>) -> bool {
    match state_of(s) {
        "blocked" | "errored" | "unread" => true,
        "done" => !zoo::is_seen(s),
        _ => false,
    }
}

fn view_for(sessions: &[Map<String, Value>]) -> View {
    let mut sorted: Vec<&Map<String, Value>> = sessions.iter().collect();
    // Priority, then name, as the page breaks ties.
    sorted.sort_by(|a, b| {
        priority(state_of(a)).cmp(&priority(state_of(b))).then_with(|| {
            let name = |s: &Map<String, Value>| s.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            name(a).cmp(&name(b))
        })
    });
    let Some(top) = sorted.first() else { return View { look: "idle", colorway: "teal", title: None } };
    let look = match (state_of(top), is_heartbeat(top)) {
        ("unread", _) => "unread",
        ("blocked" | "errored", false) => "scream",
        ("done", true) => "rest",
        _ => "idle",
    };
    let blocked = sessions.iter().filter(|s| state_of(s) == "blocked").count();
    let title = wants_attention(top).then(|| {
        let letter = folder_letter(top).map(String::from).unwrap_or_default();
        if blocked > 1 { format!("{letter} {blocked}").trim().to_string() } else { letter }
    });
    View { look, colorway: colorway(top), title: title.filter(|t| !t.is_empty()) }
}

/// The Code icon's view, over Claude Code sessions only, and the Cowork icon's, only
/// while a Cowork heartbeat monster exists. The dragon never carries a letter: there's
/// one Cowork monster and no folder to name.
fn views_for(sessions: &[Map<String, Value>]) -> (View, Option<View>) {
    let (cowork, code): (Vec<_>, Vec<_>) = sessions.iter().cloned().partition(|s| is_heartbeat(s));
    let dragon = (!cowork.is_empty()).then(|| View { title: None, ..view_for(&cowork) });
    (view_for(&code), dragon)
}

// ---- main-thread tray state ------------------------------------------------------
// NSImage isn't Send and Tauri's native-access callback must be, so images and the
// current views live here and callbacks carry only keys.

const CODE_TRAY: &str = "zoo";
const COWORK_TRAY: &str = "cowork";

type FaceKey = (&'static str, &'static str, usize);

struct TrayState {
    tray: TrayIcon,
    view: Option<View>,
    frame: usize,
    shown: bool,
    hidden_logged: bool,
}

thread_local! {
    static TRAYS: RefCell<HashMap<&'static str, TrayState>> = RefCell::new(HashMap::new());
    static IMAGES: RefCell<HashMap<FaceKey, Retained<NSImage>>> = RefCell::new(HashMap::new());
}

fn frames_of(look: &str, colorway: &str) -> usize {
    FACES.iter().filter(|(l, c, _, _)| *l == look && *c == colorway).count()
}

fn image_for(key: FaceKey) -> Option<Retained<NSImage>> {
    if let Some(img) = IMAGES.with(|i| i.borrow().get(&key).cloned()) {
        return Some(img);
    }
    let (_, _, _, png) = FACES.iter().find(|(l, c, f, _)| (*l, *c, *f) == key)?;
    let img = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))?;
    let px = img.size();
    img.setSize(NSSize::new(px.width / px.height * ICON_HEIGHT_PT, ICON_HEIGHT_PT));
    IMAGES.with(|i| i.borrow_mut().insert(key, img.clone()));
    Some(img)
}

/// Sets the status button's image directly: tray-icon's own set_icon fixes icons
/// at 18pt, too small for a face.
fn set_button_image(tray: &TrayIcon, key: FaceKey) {
    let _ = tray.with_inner_tray_icon(move |inner| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(button) = inner.ns_status_item().and_then(|item| item.button(mtm)) else { return };
        if let Some(img) = image_for(key) {
            button.setImage(Some(&img));
        }
    });
}

/// Shows or hides the status item in place. tray-icon's set_visible destroys and
/// recreates it instead, and macOS puts a new item at the far left of the whole menu
/// bar, away from the Code icon and first to go behind the notch.
fn set_shown(tray: &TrayIcon, shown: bool) {
    let _ = tray.with_inner_tray_icon(move |inner| {
        if let Some(item) = inner.ns_status_item() {
            item.setVisible(shown);
        }
    });
}

/// None hides the icon (the Cowork icon with no Cowork monster).
fn apply_view(id: &'static str, view: Option<View>) {
    let shown = view.is_some();
    let change = TRAYS.with(|t| {
        let mut t = t.borrow_mut();
        let state = t.get_mut(id)?;
        let redraw = view.is_some() && state.view != view;
        let reshow = state.shown != view.is_some();
        if redraw {
            state.view = view.clone();
            state.frame = 0;
        }
        state.shown = view.is_some();
        (redraw || reshow).then(|| (state.tray.clone(), redraw, reshow))
    });
    let Some((tray, redraw, reshow)) = change else { return };
    if let Some(view) = view.filter(|_| redraw) {
        set_button_image(&tray, (view.look, view.colorway, 0));
        // tray-icon resizes its click target to the button only inside set_icon/set_title,
        // so the title call has to come after the image changes the button's width. Its
        // set_title(None) leaves the old title in place, so clearing means an empty one.
        let _ = tray.set_title(Some(view.title.as_deref().unwrap_or("")));
    }
    // After the redraw, so a returning icon doesn't flash its old face.
    if reshow {
        set_shown(&tray, shown);
    }
}

fn tick_shake() {
    let next: Vec<(TrayIcon, FaceKey)> = TRAYS.with(|t| {
        t.borrow_mut()
            .values_mut()
            .filter_map(|state| {
                let view = state.view.as_ref().filter(|v| state.shown && v.shakes())?;
                let n = frames_of(view.look, view.colorway).max(1);
                state.frame = (state.frame + 1) % n;
                Some((state.tray.clone(), (view.look, view.colorway, state.frame)))
            })
            .collect()
    });
    for (tray, key) in next {
        set_button_image(&tray, key);
    }
}

/// On a crowded MacBook menu bar, macOS hides status items that don't fit beside
/// the notch, with no overflow menu. There's nothing to fix from here, but it
/// shouldn't happen silently.
fn check_visible() {
    let trays: Vec<(&'static str, TrayIcon)> = TRAYS.with(|t| {
        t.borrow().iter().filter(|(_, s)| s.shown && !s.hidden_logged).map(|(id, s)| (*id, s.tray.clone())).collect()
    });
    for (id, tray) in trays {
        let visible = tray.with_inner_tray_icon(|inner| {
            let Some(mtm) = MainThreadMarker::new() else { return true };
            let window = inner.ns_status_item().and_then(|item| item.button(mtm)).and_then(|b| b.window());
            window.is_none_or(|w| w.occlusionState().contains(NSWindowOcclusionState::Visible))
        });
        if matches!(visible, Ok(false)) {
            let which = if id == COWORK_TRAY { "Cowork" } else { "Code" };
            eprintln!("zoo: the {which} menu bar icon is hidden, probably because the menu bar is full; it will show again when there is room");
            TRAYS.with(|t| if let Some(s) = t.borrow_mut().get_mut(id) { s.hidden_logged = true });
        }
    }
}

// ---- popover: under the icon, or pinned wherever it was dragged ------------------
// The page can't move its own window (it's a web page with no access to the app), so
// the app watches mouse-downs on the grip strip natively and hands them to macOS as a
// window drag. A drag pins the popover: it reopens where it was put, even after a
// restart. A double-click on the grip, or "Snap back to the icon" in the menu, unpins it.
//
// Once open it stays open until dismissed: a click on either icon, or the × at the
// right end of the grip. Clicking another app or the other screen leaves it be
// (Safiyya, 2026-09-14). Unpinned and open on one screen, a click on the icon on the
// other screen brings it over under that icon instead of closing it.
//
// It's as tall as the page's content (the page POSTs /popover-height), within the room
// below its top edge. Positions are Cocoa screen points: Tauri's physical positions carry
// each screen's own pixel scale, which put the popover on the wrong screen when a Retina
// laptop sat beside a 1x monitor.

/// x, y (bottom edge), width, height, in Cocoa screen points (origin bottom-left of the
/// main screen).
type Frame = (f64, f64, f64, f64);

const EDGE_PT: f64 = 8.0;
const MIN_HEIGHT_PT: f64 = 120.0;
const CLOSE_PT: f64 = 28.0; // the × at the right end of the grip

struct Popover {
    /// Top-left (x, top edge), when pinned.
    pinned: Mutex<Option<(f64, f64)>>,
    /// When the grip was last pressed. A move soon after, button still down, is a drag.
    grip_down: Mutex<Option<Instant>>,
    /// The height the page last asked for.
    wanted_height: Mutex<f64>,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static POPOVER_NSWINDOW: AtomicUsize = AtomicUsize::new(0);

fn pin_file() -> std::path::PathBuf {
    Dirs::from_home().zoo.join("app-window.json")
}

fn load_pin() -> Option<(f64, f64)> {
    let v = zoo::read_object(&pin_file())?;
    // "top" since pins moved to screen points; an older {x, y} pin is dropped.
    Some((v.get("x")?.as_f64()?, v.get("top")?.as_f64()?))
}

fn save_pin(pin: Option<(f64, f64)>) {
    match pin {
        Some((x, top)) => {
            let body = serde_json::json!({ "x": x, "top": top }).to_string();
            let _ = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o700).open(pin_file())
                .and_then(|mut f| std::io::Write::write_all(&mut f, body.as_bytes()));
        }
        None => {
            let _ = std::fs::remove_file(pin_file());
        }
    }
}

fn frame_of(r: NSRect) -> Frame {
    (r.origin.x, r.origin.y, r.size.width, r.size.height)
}

fn contains(f: Frame, (x, y): (f64, f64)) -> bool {
    x >= f.0 && x < f.0 + f.2 && y >= f.1 && y <= f.1 + f.3
}

/// Left edge for the popover centred under the icon, kept inside the icon's screen.
fn left_under(icon: Frame, visible: Frame, width: f64) -> f64 {
    let lo = visible.0 + EDGE_PT;
    let hi = (visible.0 + visible.2 - width - EDGE_PT).max(lo);
    (icon.0 + icon.2 / 2.0 - width / 2.0).clamp(lo, hi)
}

/// As tall as the page wants, within the room below `top` on its screen.
fn fit_height(wanted: f64, top: f64, visible: Frame) -> f64 {
    wanted.min(top - visible.1 - EDGE_PT).max(MIN_HEIGHT_PT)
}

/// The popover's NSWindow.
fn popover_window(_main_thread: MainThreadMarker) -> Option<&'static NSWindow> {
    // SAFETY: stored once from the popover's window, which lives as long as the app;
    // AppKit windows are only touched on the main thread, which the marker proves.
    unsafe { (POPOVER_NSWINDOW.load(Ordering::Relaxed) as *const NSWindow).as_ref() }
}

/// The visible frame (below the menu bar, beside the Dock) of the screen holding a
/// point. None for a point on no screen, such as a pin on an unplugged monitor.
fn visible_frame_at(mtm: MainThreadMarker, point: (f64, f64)) -> Option<Frame> {
    NSScreen::screens(mtm).iter().find(|s| contains(frame_of(s.frame()), point)).map(|s| frame_of(s.visibleFrame()))
}

fn set_frame(win: &NSWindow, left: f64, top: f64, height: f64) {
    win.setFrame_display(NSRect::new(NSPoint::new(left, top - height), NSSize::new(POPOVER_SIZE.0, height)), true);
}

/// An icon's frame and the visible frame of its screen. After a click, the screen is
/// the one under the mouse: that's the menu bar that was clicked.
fn icon_spot(tray: &TrayIcon, clicked: bool) -> Option<(Frame, Frame)> {
    tray.with_inner_tray_icon(move |inner| {
        let mtm = MainThreadMarker::new()?;
        let window = inner.ns_status_item()?.button(mtm)?.window();
        let visible = if clicked {
            let m = NSEvent::mouseLocation();
            visible_frame_at(mtm, (m.x, m.y))?
        } else {
            frame_of(window.as_ref()?.screen()?.visibleFrame())
        };
        let top = visible.1 + visible.3;
        let icon = window
            .map(|w| frame_of(w.frame()))
            .filter(|f| (f.0 + f.2 / 2.0) >= visible.0 && (f.0 + f.2 / 2.0) < visible.0 + visible.2 && (f.1 - top).abs() < 60.0)
            .unwrap_or_else(|| {
                // The icon's window is on another screen's menu bar: go by the mouse.
                let m = NSEvent::mouseLocation();
                (m.x - 10.0, top, 20.0, 0.0)
            });
        Some((icon, visible))
    })
    .ok()
    .flatten()
}

fn snap_back(app: &AppHandle) {
    let popover = app.state::<Popover>();
    *popover.pinned.lock().unwrap() = None;
    *popover.grip_down.lock().unwrap() = None;
    save_pin(None);
    show_popover(app);
}

/// Grip strip handling, installed once. Runs on the main thread before the event
/// reaches the page; grip clicks are consumed so the page never sees them.
fn watch_grip() {
    let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a valid event for the duration of the handler.
        let ev = unsafe { event.as_ref() };
        let (Some(mtm), Some(app)) = (MainThreadMarker::new(), APP.get()) else { return event.as_ptr() };
        let Some(w) = ev.window(mtm) else { return event.as_ptr() };
        if Retained::as_ptr(&w) as usize != POPOVER_NSWINDOW.load(Ordering::Relaxed) {
            return event.as_ptr();
        }
        if ev.locationInWindow().y < w.frame().size.height - GRIP_PT {
            return event.as_ptr();
        }
        if ev.locationInWindow().x >= w.frame().size.width - CLOSE_PT {
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || hide_popover(&app));
        } else if ev.clickCount() >= 2 {
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || snap_back(&app));
        } else {
            *app.state::<Popover>().grip_down.lock().unwrap() = Some(Instant::now());
            w.performWindowDragWithEvent(ev);
        }
        std::ptr::null_mut()
    });
    // SAFETY: the handler returns the event it was given, or null to consume it.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &block) };
    // Both live as long as the app.
    std::mem::forget(monitor);
    std::mem::forget(block);
}

fn on_moved(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let popover = app.state::<Popover>();
    let held = NSEvent::pressedMouseButtons() & 1 == 1;
    let dragging = held && popover.grip_down.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(10));
    let mut pinned = popover.pinned.lock().unwrap();
    if pinned.is_none() && !dragging {
        return; // our own placement under the icon, or a resize
    }
    let Some(f) = popover_window(mtm).map(|w| frame_of(w.frame())) else { return };
    *pinned = Some((f.0, f.1 + f.3));
    save_pin(*pinned);
}

fn hide_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(POPOVER) {
        let _ = win.hide();
    }
    *app.state::<Popover>().grip_down.lock().unwrap() = None;
}

/// A click on either icon. Open: close it, unless it's unpinned on another screen, in
/// which case it comes over under this icon.
fn toggle_popover(tray: &TrayIcon) {
    let app = tray.app_handle();
    let (Some(win), Some(mtm)) = (app.get_webview_window(POPOVER), MainThreadMarker::new()) else { return };
    let spot = icon_spot(tray, true);
    if win.is_visible().unwrap_or(false) {
        let pinned = app.state::<Popover>().pinned.lock().unwrap().is_some();
        let here = popover_window(mtm).and_then(|w| w.screen()).map(|s| frame_of(s.visibleFrame()));
        if pinned || spot.is_none_or(|(_, visible)| here == Some(visible)) {
            hide_popover(app);
            return;
        }
    }
    place_and_show(app, spot);
}

/// Opens the popover without a click on the icon: when the app is launched by hand,
/// double-clicked while running, or a second copy is started. A menu bar app has no
/// window, so otherwise nothing would visibly happen.
fn show_popover(app: &AppHandle) {
    let spot = app.tray_by_id(CODE_TRAY).and_then(|t| icon_spot(&t, false));
    place_and_show(app, spot);
}

/// Pinned: where it was put, while that's still on a screen. Otherwise under the icon,
/// or with no icon to go by (hidden by a full menu bar, say), top centre of the main
/// screen.
fn place_and_show(app: &AppHandle, spot: Option<(Frame, Frame)>) {
    let (Some(win), Some(mtm)) = (app.get_webview_window(POPOVER), MainThreadMarker::new()) else { return };
    let Some(ns) = popover_window(mtm) else { return };
    let popover = app.state::<Popover>();
    let pinned = *popover.pinned.lock().unwrap();
    let at_pin = pinned.and_then(|(x, top)| visible_frame_at(mtm, (x + 40.0, top - 10.0)).map(|v| (x, top, v)));
    if pinned.is_some() && at_pin.is_none() {
        *popover.pinned.lock().unwrap() = None; // its screen was unplugged
        save_pin(None);
    }
    let placed = at_pin
        .or_else(|| spot.map(|(icon, v)| (left_under(icon, v, POPOVER_SIZE.0), icon.1, v)))
        .or_else(|| {
            let v = frame_of(NSScreen::screens(mtm).firstObject()?.visibleFrame());
            Some((v.0 + (v.2 - POPOVER_SIZE.0) / 2.0, v.1 + v.3 - EDGE_PT, v))
        });
    if let Some((left, top, visible)) = placed {
        let wanted = *popover.wanted_height.lock().unwrap();
        set_frame(ns, left, top, fit_height(wanted, top, visible));
    }
    let _ = win.show();
    let _ = win.set_focus();
}

/// The page's content height changed: resize, keeping the top edge where it is.
fn fit_popover(app: &AppHandle, wanted: f64) {
    *app.state::<Popover>().wanted_height.lock().unwrap() = wanted;
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(ns) = popover_window(mtm) else { return };
    let Some(visible) = ns.screen().map(|s| frame_of(s.visibleFrame())) else { return };
    let f = frame_of(ns.frame());
    let top = f.1 + f.3;
    let height = fit_height(wanted, top, visible);
    if (height - f.3).abs() >= 1.0 {
        set_frame(ns, f.0, top, height);
    }
}

// ---- app -------------------------------------------------------------------------

/// Starts the viewer server. Runs inside setup, after the single-instance plugin
/// has had its chance, so a second copy hands over instead of failing on the port.
fn start_server() -> u16 {
    let server = Arc::new(Server::new(Dirs::from_home(), crate::server::port()));
    if let Err(problem) = server.prepare() {
        eprintln!("zoo: refusing to start: {problem}. Fix with: chmod 700 ~/.zoo ~/.zoo/requests ~/.zoo/decisions");
        std::process::exit(1);
    }
    let http = match server.bind() {
        Ok(http) => http,
        Err(e) => {
            eprintln!("zoo: can't open the viewer server ({e}). Is bin/zoo-serve.js still running under launchd?");
            std::process::exit(1);
        }
    };
    server.on_popover_height(|height| {
        if let Some(app) = APP.get() {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || fit_popover(&handle, height));
        }
    });
    let port = server.port();
    {
        let server = server.clone();
        std::thread::spawn(move || server.serve(http));
    }
    // The app running counts as an open viewer: its popover can answer a prompt at any
    // time, so hooks should hold for it even while it's closed (NOTES.md, Phase 3).
    std::thread::spawn(move || loop {
        server.touch_heartbeat();
        std::thread::sleep(Duration::from_secs(20));
    });
    port
}

pub fn run() {
    // Started by the login item, which passes --login: stay quiet. Started by hand:
    // open the popover, so it's clear the app is running.
    let at_login = std::env::args().any(|a| a == "--login");

    let app = tauri::Builder::default()
        // First, so a second copy (the build folder's, say) gives way before it
        // touches the port: the running zoo opens its popover instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_popover(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--login"])))
        .manage(Popover {
            pinned: Mutex::new(load_pin()),
            grip_down: Mutex::new(None),
            wanted_height: Mutex::new(POPOVER_SIZE.1),
        })
        .setup(move |app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let port = start_server();

            let url = format!("http://127.0.0.1:{port}/?app=1").parse().expect("viewer url");
            let win = WebviewWindowBuilder::new(app, POPOVER, WebviewUrl::External(url))
                .title("zoo")
                .inner_size(POPOVER_SIZE.0, POPOVER_SIZE.1)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .build()?;
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            // No hiding on blur: it stays open until an icon or the grip's × closes it.
            win.on_window_event(move |event| {
                if let WindowEvent::Moved(_) = event {
                    on_moved(&handle);
                }
            });
            if let Ok(ns) = win.ns_window() {
                POPOVER_NSWINDOW.store(ns as usize, Ordering::Relaxed);
            }
            watch_grip();

            // Launch at login is on by default the first time; the menu turns it off. A run
            // on a non-default port is a test alongside another viewer, and must not sign
            // itself up to start at login on the default one.
            let autolaunch = app.autolaunch();
            let marker = Dirs::from_home().zoo.join("app-login-item-set");
            if !marker.exists() && std::env::var_os("ZOO_PORT").is_none() {
                let _ = autolaunch.enable();
                let _ = std::fs::write(&marker, b"");
            } else if autolaunch.is_enabled().unwrap_or(false) {
                // Rewrites the login item, so it always carries --login and this copy's path.
                let _ = autolaunch.enable();
            }
            let login = CheckMenuItem::with_id(app, "login", "Open at login", true, autolaunch.is_enabled().unwrap_or(false), None::<&str>)?;
            let snap = MenuItem::with_id(app, "snap", "Snap back to the icon", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit zoo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&snap, &login, &PredefinedMenuItem::separator(app)?, &quit])?;

            let first = FACES.iter().find(|(l, c, _, _)| *l == "idle" && *c == "teal").expect("idle face");
            let dragon = FACES.iter().find(|(l, c, _, _)| *l == "idle" && *c == "dragon").expect("dragon face");
            // Both icons open the one popover, under whichever was clicked.
            let on_click = |tray: &TrayIcon, event: TrayIconEvent| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    toggle_popover(tray);
                }
            };
            let tray = TrayIconBuilder::with_id(CODE_TRAY)
                .icon(tauri::image::Image::from_bytes(first.3)?)
                .tooltip("zoo")
                .menu(&menu)
                .show_menu_on_left_click(false)
                // Menu events are app-wide, so this one handler also serves the Cowork
                // icon's copy of the menu. A second handler would run each item twice.
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "snap" => snap_back(app),
                    "login" => {
                        let a = app.autolaunch();
                        let _ = if a.is_enabled().unwrap_or(false) { a.disable() } else { a.enable() };
                        let _ = login.set_checked(a.is_enabled().unwrap_or(false));
                    }
                    _ => {}
                })
                .on_tray_icon_event(on_click)
                .build(app)?;
            // Built second, so macOS places it just left of the Code icon. It stays in
            // that slot while hidden.
            let cowork = TrayIconBuilder::with_id(COWORK_TRAY)
                .icon(tauri::image::Image::from_bytes(dragon.3)?)
                .tooltip("zoo · Cowork")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(on_click)
                .build(app)?;
            set_shown(&cowork, false);
            TRAYS.with(|t| {
                let mut t = t.borrow_mut();
                t.insert(CODE_TRAY, TrayState { tray, view: None, frame: 0, shown: true, hidden_logged: false });
                t.insert(COWORK_TRAY, TrayState { tray: cowork, view: None, frame: 0, shown: false, hidden_logged: false });
            });

            // Sessions are read once a second; a face shakes at 8 fps while it should.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let dirs = Dirs::from_home();
                let mut last: Option<(View, Option<View>)> = None;
                let mut ticks = 0u64;
                loop {
                    if ticks % 8 == 0 {
                        let views = views_for(&zoo::read_sessions(&dirs, &Config::load(&dirs)));
                        if last.as_ref() != Some(&views) {
                            last = Some(views.clone());
                            let (code, cowork) = views;
                            let _ = handle.run_on_main_thread(move || {
                                apply_view(CODE_TRAY, Some(code));
                                apply_view(COWORK_TRAY, cowork);
                            });
                        }
                    }
                    if ticks % 80 == 5 {
                        let _ = handle.run_on_main_thread(check_visible);
                    }
                    if last.as_ref().is_some_and(|(code, cowork)| code.shakes() || cowork.as_ref().is_some_and(View::shakes)) {
                        let _ = handle.run_on_main_thread(tick_shake);
                    }
                    ticks += 1;
                    std::thread::sleep(FRAME);
                }
            });

            if !at_login {
                // Give the status item a moment to be laid out so the popover lands under it.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(600));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || show_popover(&h));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("zoo failed to start");
    // Double-clicking zoo.app while it runs reopens it; show the popover.
    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            show_popover(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(state: &str, name: &str, dir: &str, seed: &str) -> Map<String, Value> {
        serde_json::from_value(serde_json::json!({ "state": state, "name": name, "project_dir": dir, "monster_seed": seed })).unwrap()
    }

    fn with_colorway(mut s: Map<String, Value>, c: &str) -> Map<String, Value> {
        s.insert("colorway".into(), c.into());
        s
    }

    #[test]
    fn the_stored_colorway_wins_over_the_seed() {
        // Seed 00 would derive teal.
        let v = view_for(&[with_colorway(session("blocked", "a", "/x/zoo", "00"), "rose")]);
        assert_eq!(v.colorway, "rose");
    }

    #[test]
    fn missing_or_unknown_colorway_falls_back_to_the_seed() {
        // Sessions from before colours were stored keep their monster_seed colour.
        assert_eq!(view_for(&[session("blocked", "a", "/x/zoo", "02")]).colorway, "violet");
        assert_eq!(view_for(&[with_colorway(session("blocked", "a", "/x/zoo", "03"), "gold")]).colorway, "rose");
        assert_eq!(view_for(&[with_colorway(session("blocked", "a", "/x/zoo", "zz"), "")]).colorway, "teal");
    }

    #[test]
    fn same_project_sessions_keep_the_distinct_colours_they_were_given() {
        // Two sessions in one folder share a seed. The hook gave them different colours
        // (lib/reducer.js excludes colours live sessions hold); each shows its own.
        let a = with_colorway(session("blocked", "a", "/x/zoo", "00"), "indigo");
        let b = with_colorway(session("blocked", "b", "/x/zoo", "00"), "violet");
        assert_eq!(colorway(&a), "indigo");
        assert_eq!(colorway(&b), "violet");
        assert_eq!(view_for(&[b.clone(), a.clone()]).colorway, "indigo", "the top session's colour: a sorts first");
    }

    fn heartbeat(state: &str) -> Map<String, Value> {
        serde_json::from_value(serde_json::json!({ "state": state, "name": "Cowork stu", "client": "cowork-heartbeat", "colorway": "rose" })).unwrap()
    }

    #[test]
    fn a_cowork_heartbeat_monster_shows_the_dragon() {
        let working = view_for(&[heartbeat("working")]);
        assert_eq!((working.look, working.colorway, working.shakes()), ("idle", "dragon", false));
        let done = view_for(&[heartbeat("done")]);
        assert_eq!((done.look, done.colorway, done.shakes(), done.title), ("rest", "dragon", false, None));
        let unread = view_for(&[heartbeat("unread")]);
        assert_eq!((unread.look, unread.colorway, unread.shakes()), ("unread", "dragon", true));
        // Every dragon look has faces built for it.
        for look in ["idle", "rest", "unread"] {
            assert!(frames_of(look, "dragon") >= 1, "{look}");
        }
        assert_eq!(frames_of("unread", "dragon"), 4);
    }

    #[test]
    fn no_cowork_monster_no_cowork_icon() {
        let (code, cowork) = views_for(&[session("blocked", "a", "/x/zoo", "02")]);
        assert_eq!(code, View { look: "scream", colorway: "violet", title: Some("Z".into()) });
        assert_eq!(cowork, None);
        assert_eq!(views_for(&[]), (View { look: "idle", colorway: "teal", title: None }, None));
    }

    #[test]
    fn the_cowork_monster_gets_its_own_icon_and_the_code_icon_ignores_it() {
        // Unread Cowork would outrank working Code on one icon; split, each shows its own.
        let mut hb = heartbeat("unread");
        hb.insert("project_dir".into(), "/x/podcast".into());
        let (code, cowork) = views_for(&[hb.clone(), session("working", "a", "/x/jarvis", "01")]);
        assert_eq!(code, View { look: "idle", colorway: "indigo", title: None });
        let cowork = cowork.expect("a Cowork icon while the monster exists");
        assert_eq!((cowork.look, cowork.colorway, cowork.shakes()), ("unread", "dragon", true));
        assert_eq!(cowork.title, None, "no letter on the dragon, even with a folder");

        // Only Cowork running: the Code icon stays the plain idle face.
        let (code, cowork) = views_for(&[heartbeat("done")]);
        assert_eq!(code, View { look: "idle", colorway: "teal", title: None });
        assert_eq!(cowork.map(|v| v.look), Some("rest"));
    }

    #[test]
    fn the_blocked_count_counts_only_code_sessions() {
        let (code, _) = views_for(&[heartbeat("blocked"), session("blocked", "a", "/x/alpha", "00")]);
        assert_eq!(code.title.as_deref(), Some("A"));
    }

    #[test]
    fn the_popover_centres_under_the_icon_and_stays_on_its_screen() {
        // A 1512x944 laptop with a 1920x1080 monitor to its right; menu bars 33pt.
        let laptop = (0.0, 0.0, 1512.0, 944.0 - 33.0);
        let monitor = (1512.0, 0.0, 1920.0, 1080.0 - 33.0);
        assert_eq!(left_under((900.0, 911.0, 30.0, 33.0), laptop, 380.0), 725.0);
        assert_eq!(left_under((2400.0, 1047.0, 30.0, 33.0), monitor, 380.0), 2225.0, "on the monitor, not the laptop");
        // An icon near a screen's right edge keeps the popover 8pt inside it.
        assert_eq!(left_under((3420.0, 1047.0, 30.0, 33.0), monitor, 380.0), 1512.0 + 1920.0 - 380.0 - 8.0);
        assert_eq!(left_under((1520.0, 1047.0, 30.0, 33.0), monitor, 380.0), 1520.0);
    }

    #[test]
    fn the_popover_is_as_tall_as_its_content_within_the_screen() {
        let laptop = (0.0, 70.0, 1512.0, 841.0); // Dock at the bottom
        assert_eq!(fit_height(310.0, 911.0, laptop), 310.0);
        assert_eq!(fit_height(40.0, 911.0, laptop), MIN_HEIGHT_PT);
        assert_eq!(fit_height(5000.0, 911.0, laptop), 911.0 - 70.0 - 8.0, "stops above the Dock");
    }

    #[test]
    fn nothing_running_is_idle_teal() {
        assert_eq!(view_for(&[]), View { look: "idle", colorway: "teal", title: None });
    }

    #[test]
    fn blocked_beats_everything_and_shows_its_folder_letter() {
        let v = view_for(&[
            session("unread", "a", "/x/alpha", "00"),
            session("blocked", "Fix login", "/Users/s/Developer/zoo", "02"),
            session("working", "b", "/x/beta", "01"),
        ]);
        assert_eq!(v, View { look: "scream", colorway: "violet", title: Some("Z".into()) });
    }

    #[test]
    fn several_blocked_add_the_count() {
        let v = view_for(&[session("blocked", "a", "/x/alpha", "00"), session("blocked", "b", "/x/beta", "00")]);
        assert_eq!(v.title.as_deref(), Some("A 2"));
    }

    #[test]
    fn errored_screams_without_a_count() {
        let v = view_for(&[session("errored", "a", "/x/widget", "03")]);
        assert_eq!(v, View { look: "scream", colorway: "rose", title: Some("W".into()) });
    }

    #[test]
    fn unread_grins_with_its_letter_and_working_has_none() {
        assert_eq!(view_for(&[session("unread", "a", "/x/jarvis", "00")]).title.as_deref(), Some("J"));
        let working = view_for(&[session("working", "a", "/x/jarvis", "01"), session("spawned", "b", "/x/zoo", "00")]);
        assert_eq!(working, View { look: "idle", colorway: "indigo", title: None });
    }

    #[test]
    fn done_shows_its_letter_still_and_outranks_working() {
        let v = view_for(&[session("working", "a", "/x/jarvis", "01"), session("done", "b", "/x/zoo", "02")]);
        assert_eq!(v, View { look: "idle", colorway: "violet", title: Some("Z".into()) });
        assert!(!v.shakes());
        // unread still wins over done
        let u = view_for(&[session("done", "a", "/x/zoo", "02"), session("unread", "b", "/x/jarvis", "00")]);
        assert_eq!((u.look, u.title.as_deref()), ("unread", Some("J")));
    }

    #[test]
    fn a_dismissed_done_session_loses_its_letter() {
        let mut s = session("done", "b", "/x/zoo", "02");
        s.insert("finished_at".into(), "2026-09-11T10:00:00.000Z".into());
        s.insert("seen_for".into(), "2026-09-11T10:00:00.000Z".into());
        assert_eq!(view_for(&[s]).title, None);
    }
}
