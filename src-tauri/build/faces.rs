// Menu bar faces, made at build time from the pose art. Each face is a crop of a
// pose's head, box-filtered to HEIGHT px (20pt at 2x). Crop boxes are in each
// species' pose PNGs' own pixels, which every scarf colorway shares.
pub const HEIGHT: u32 = 40;
pub const PAD: u32 = 2; // horizontal room for the shake
pub const SHAKE: [i32; 4] = [0, 2, 0, -2]; // px at 2x, one frame each at 8 fps

pub struct Crop { pub x: u32, pub y: u32, pub w: u32, pub h: u32 }

pub fn crop_for(species: &str, pose: &str) -> Crop {
    match (species, pose) {
        ("scarf", "blocked") => Crop { x: 107, y: 15, w: 491, h: 377 },
        ("scarf", "dancing") => Crop { x: 169, y: 9, w: 444, h: 353 },
        // ui/monsters/dragon/SPEC.md: whole head, horns and glasses included
        ("dragon", "working") => Crop { x: 300, y: 20, w: 500, h: 540 },
        ("dragon", "sleeping") => Crop { x: 20, y: 40, w: 480, h: 560 },
        (s, p) => panic!("no menu bar crop for {s} pose {p}"),
    }
}

/// RGBA face from an RGBA pose image `sw` px wide, shifted right by `shift` px
/// (-PAD..=PAD), with the popover's red unread dot when `dot` is set.
pub fn face(src: &[u8], sw: u32, species: &str, pose: &str, shift: i32, dot: bool) -> (Vec<u8>, u32, u32) {
    let c = crop_for(species, pose);
    let th = HEIGHT;
    let tw = (c.w as f32 * th as f32 / c.h as f32).round() as u32;
    let cw = tw + 2 * PAD;
    let mut out = vec![0u8; (cw * th * 4) as usize];
    for ty in 0..th {
        for tx in 0..tw {
            let sx0 = c.x + tx * c.w / tw;
            let sx1 = (c.x + (tx + 1) * c.w / tw).max(sx0 + 1);
            let sy0 = c.y + ty * c.h / th;
            let sy1 = (c.y + (ty + 1) * c.h / th).max(sy0 + 1);
            let (mut acc, mut n) = ([0u64; 4], 0u64);
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy * sw + sx) * 4) as usize;
                    let a = src[i + 3] as u64;
                    for k in 0..3 { acc[k] += src[i + k] as u64 * a; }
                    acc[3] += a;
                    n += 1;
                }
            }
            let ox = (PAD as i32 + tx as i32 + shift) as u32;
            let o = ((ty * cw + ox) * 4) as usize;
            if acc[3] > 0 {
                for k in 0..3 { out[o + k] = (acc[k] / acc[3]) as u8; }
                out[o + 3] = (acc[3] / n) as u8;
            }
        }
    }
    if dot {
        // The popover's unread badge, top right: red with a dark rim.
        let (cx, cy, r) = (cw as f32 - 7.0, 7.0, 6.0);
        for y in 0..th {
            for x in 0..cw {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                let o = ((y * cw + x) * 4) as usize;
                if d <= r - 1.5 { out[o..o + 4].copy_from_slice(&[217, 54, 43, 255]); }
                else if d <= r { out[o..o + 4].copy_from_slice(&[17, 17, 17, 255]); }
            }
        }
    }
    (out, cw, th)
}
