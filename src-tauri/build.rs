// Embeds the viewer page and the monster art into the binary, and renders the menu
// bar faces from the art, so the app doesn't depend on the repo being where it was.
#[path = "build/faces.rs"]
mod faces;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

const POSES: [&str; 6] = ["standing", "working", "blocked", "dancing", "errored", "sleeping"];
const COLORWAYS: [&str; 4] = ["teal", "indigo", "violet", "rose"];

fn is_art(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".png") else { return false };
    let (pose, suffix) = match stem.split_once('_') {
        Some((p, s)) => (p, Some(s)),
        None => (stem, None),
    };
    POSES.contains(&pose)
        && suffix.map_or(true, |s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase()))
}

fn decode_rgba(path: &Path) -> (Vec<u8>, u32, u32) {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut reader = png::Decoder::new(std::io::BufReader::new(file)).read_info().expect("png header");
    let mut buf = vec![0; reader.output_buffer_size().expect("png size")];
    let info = reader.next_frame(&mut buf).expect("png frame");
    assert!(
        info.color_type == png::ColorType::Rgba && info.bit_depth == png::BitDepth::Eight,
        "{} must be 8-bit RGBA",
        path.display()
    );
    buf.truncate(info.buffer_size());
    (buf, info.width, info.height)
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().expect("png header").write_image_data(rgba).expect("png data");
    }
    out
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let ui = manifest.join("../ui").canonicalize().expect("ui/ next to src-tauri/");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed=build/faces.rs");
    println!("cargo:rerun-if-changed={}", ui.join("index.html").display());
    println!("cargo:rerun-if-changed={}", ui.join("monsters").display());

    let mut gen = String::new();
    writeln!(gen, "pub static INDEX_HTML: &str = include_str!({:?});", ui.join("index.html")).unwrap();

    // Every pose image, as (species, file stem, bytes). The server's art route
    // serves exactly these.
    writeln!(gen, "pub static ART: &[(&str, &str, &[u8])] = &[").unwrap();
    let mut species: Vec<_> = std::fs::read_dir(ui.join("monsters")).unwrap().flatten()
        .filter(|e| e.path().is_dir()).map(|e| e.path()).collect();
    species.sort();
    for dir in &species {
        println!("cargo:rerun-if-changed={}", dir.display());
        let sp = dir.file_name().unwrap().to_str().unwrap().to_string();
        let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_art(n)).collect();
        files.sort();
        for name in files {
            let stem = name.trim_end_matches(".png");
            writeln!(gen, "    ({sp:?}, {stem:?}, include_bytes!({:?})),", dir.join(&name)).unwrap();
        }
    }
    writeln!(gen, "];").unwrap();

    // Menu bar faces for the scarf monster: (look, colorway, frame) -> PNG.
    // scream = blocked pose, unread = dancing pose with the red dot, idle = dancing, still.
    let faces_dir = out.join("faces");
    std::fs::create_dir_all(&faces_dir).unwrap();
    writeln!(gen, "pub static FACES: &[(&str, &str, usize, &[u8])] = &[").unwrap();
    for colorway in COLORWAYS {
        let suffix = if colorway == "teal" { String::new() } else { format!("_{colorway}") };
        for (look, pose, dot, frames) in [
            ("scream", "blocked", false, &faces::SHAKE[..]),
            ("unread", "dancing", true, &faces::SHAKE[..]),
            ("idle", "dancing", false, &faces::SHAKE[..1]),
        ] {
            let (src, sw, _) = decode_rgba(&ui.join(format!("monsters/scarf/{pose}{suffix}.png")));
            for (i, shift) in frames.iter().enumerate() {
                let (rgba, w, h) = faces::face(&src, sw, "scarf", pose, *shift, dot);
                let path = faces_dir.join(format!("{look}_{colorway}_{i}.png"));
                std::fs::write(&path, encode_png(&rgba, w, h)).unwrap();
                writeln!(gen, "    ({look:?}, {colorway:?}, {i}, include_bytes!({path:?})),").unwrap();
            }
        }
    }
    // The dragon (Cowork heartbeat monsters) comes in one palette, "dragon": idle is the
    // awake working face, rest the sleeping face (done), unread sleeping with the dot.
    for (look, pose, dot, frames) in [
        ("idle", "working", false, &faces::SHAKE[..1]),
        ("rest", "sleeping", false, &faces::SHAKE[..1]),
        ("unread", "sleeping", true, &faces::SHAKE[..]),
    ] {
        let (src, sw, _) = decode_rgba(&ui.join(format!("monsters/dragon/{pose}.png")));
        for (i, shift) in frames.iter().enumerate() {
            let (rgba, w, h) = faces::face(&src, sw, "dragon", pose, *shift, dot);
            let path = faces_dir.join(format!("{look}_dragon_{i}.png"));
            std::fs::write(&path, encode_png(&rgba, w, h)).unwrap();
            writeln!(gen, "    ({look:?}, \"dragon\", {i}, include_bytes!({path:?})),").unwrap();
        }
    }
    writeln!(gen, "];").unwrap();

    std::fs::write(out.join("assets.rs"), gen).unwrap();
    tauri_build::build()
}
