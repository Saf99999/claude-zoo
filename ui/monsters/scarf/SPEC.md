# Scarf monster — pose spec for phase 4

First species. Built and reviewed in a separate design session (the big single-monster
showcase, rig-reference.html, came with the handoff but isn't kept in the repo; its values
are all below). This file is what a real integration into ui/index.html
needs: the assets, the state map, the animation timings, and the overlay positions.

## Assets (this folder)

Six transparent PNGs, one per pose, already background-removed and cropped tight to the
figure with a small pad. Different aspect ratios per pose (standing is tall/portrait,
sleeping is wide/short, working includes a laptop+table prop) — that's expected, not a bug,
see "Framing" below.

- standing.png — spawned
- working.png — working (at a laptop, glasses on)
- blocked.png — blocked (freaking out, full body)
- dancing.png — done and unread (same pose, unread adds the badge overlay)
- errored.png — errored (looking sick, thermometer)
- sleeping.png — stale (side sleeping)

## State → pose map

```
spawned  -> standing
working  -> working
blocked  -> blocked
done     -> dancing
unread   -> dancing (+ badge overlay)
errored  -> errored
stale    -> sleeping
```

This mirrors the reducer's state names exactly (same ones ui/index.html already uses on
`.blob[data-state]`), so the swap is: keep everything about how a cell gets its state,
replace what renders once it has one.

## Framing (the part that needs a decision, not just a port)

The design session's rig showed one monster at a time in a large portrait stage. zoo's
actual grid shows many small cells at once (currently a 56px blob in a 90px cell). Six
poses at very different aspect ratios, shown small and side by side, need a consistent way
to sit in a cell or they'll visibly change size as a session's state changes.

What worked in the rig and should carry over: a fixed-size box per cell, each pose image
`object-fit: contain`, `object-position: 50% 100%` (bottom-anchored, so every pose "stands"
on the same line regardless of its own aspect ratio). Recommend sizing the box bigger than
the old 56px blob — the character reads as a color blob, not a monster, below roughly 60px.
Something like 72-84px tall inside a slightly widened cell is a reasonable starting point;
tune it live once it's actually in the popover.

One thing that may be a feature: sleeping is a wide, short image, so it'll naturally render
smaller within a bottom-anchored contain box than standing does. The old blob CSS already
shrank and dimmed the stale state on purpose (`width:30px; opacity:0.55`). Sleeping quietly
being the visually smallest state in the grid matches that intent without extra rules.

## Animation per pose (CSS keyframes, verified from the working rig)

Apply to the pose's own element, not a wrapper — each pose is its own image, only the
active one has opacity 1, matched to state the same way `.blob[data-state]` was matched.

```css
/* spawned (standing, no dedicated loop pose — the only state that's just a static
   render breathing in place rather than a distinct still) */
@keyframes breathe { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-3px) scale(1.012); } }
/* spawned uses this at 3.6s ease-in-out infinite, on the standing render (no new pose
   asset); the rig scaled it from near the feet, transform-origin 50% 92% */

@keyframes bounce-loop {
  0%, 100% { transform: translateY(0) rotate(-1.5deg); }
  50% { transform: translateY(-9px) rotate(1.5deg); }
}
/* dancing (done, unread): bounce-loop 0.9s ease-in-out infinite */

@keyframes sleep-breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(1px) scale(1.007); }
}
/* sleeping (stale): sleep-breathe 4.2s ease-in-out infinite */

@keyframes tremble-loop {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  25% { transform: translate(-1.5px, 0) rotate(-0.6deg); }
  50% { transform: translate(0, -1px) rotate(0deg); }
  75% { transform: translate(1.5px, 0) rotate(0.6deg); }
}
/* blocked: tremble-loop 0.28s ease-in-out infinite */

@keyframes sniffle-breathe {
  0%, 82%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
  90% { transform: translateY(1px) rotate(-1deg) scale(0.995); }
  96% { transform: translateY(0) rotate(1deg) scale(1); }
}
/* errored: sniffle-breathe 3.4s ease-in-out infinite */

@keyframes type-tap {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-2px) rotate(0.5deg); }
}
/* working: type-tap 0.5s ease-in-out infinite */
```

At small grid size most of these will barely read (a 9px bounce is subtle even at full
size). Worth checking live whether the small-cell versions need exaggerated amplitudes, or
whether that's more motion than a glanceable status grid actually wants — this wasn't
tested at cell scale, only at the rig's large stage size.

## Overlays

Three, layered on top of the pose image, shown only for their state:

**unread — red badge.** 16px circle, `background: var(--danger)` (or whatever red the app
already uses for its own danger/unread color), positioned at `top: 33%; left: 64%` of the
monster's box — sits on the dancing pose's shoulder/ear, not floating above the head (that
was a real bug, fixed this session). `animation: badge-pulse 1s ease-in-out infinite`:
`0%,100% { transform: scale(1); } 50% { transform: scale(1.35); }`. These percentages were
tuned against the rig's 260x380 box and the dancing.png crop that ships in this folder — if
the cell size or the image gets re-cropped, re-check this position visually, don't assume
the percentages still land in the right place.

**blocked — question bubble.** 34px rounded-square speech bubble (`border-radius: 50% 50%
50% 6px`) with a "?" centered in it, positioned at `top: 11%; left: 62%`. `animation:
bob-bubble 1.4s ease-in-out infinite`: `0%,100% { transform: translateY(0); } 50% {
transform: translateY(-4px); }`. No ring around the monster — that was removed deliberately,
the bubble alone reads as "waiting on you" without needing the pulsing circle.

**stale — sleep Z's.** Three `<span>` characters ("Z"), sizes 14/19/24px, staggered
`animation-delay` 0s/0.9s/1.8s, each running `drift-up-sleep 2.7s ease-in infinite`:
`0% { transform: translate(0,0) scale(0.5); opacity:0; } 18% { opacity:1; } 100% {
transform: translate(20px,-38px) scale(1.25); opacity:0; }`. Anchored near the snout so they
read as breath, not decoration sitting on top of him — position was `top: 71%; left: 25%`
for the sleeping pose specifically (different anchor than the other two overlays since the
sleeping crop is a different shape). Same caveat as the badge: re-check visually if the
sleeping.png crop changes.

## Colorways

Four fur colors of the same rig, same six poses, same everything else (scarf, horns,
eyes, paw pads, thermometer, laptop — all untouched). This is a palette swap, not a new
species: same SPEC in every other respect.

- teal (no suffix) — `standing.png`, `working.png`, etc. — the original, already covered
  above.
- indigo — `standing_indigo.png`, `working_indigo.png`, etc.
- violet — `standing_violet.png`, `working_violet.png`, etc.
- rose — `standing_rose.png`, `working_rose.png`, etc.

24 files total in this folder: 6 poses x 4 colorways, flat naming, `{pose}.png` for teal
and `{pose}_{colorway}.png` for the other three. Pick the file by pose the same way as
today, just with the colorway suffix decided once per session (zoo stores it on the
session when it starts; see the note below) and reused across
all six pose lookups for that session — never mix colorways within one session's frames.

Made by rotating fur hue only (HSV, saturation and value untouched, so all shading and
texture survive), leaving the scarf's orange/green, the horns' cream, and every gray
detail (eyes, teeth, paw pads) alone. The errored pose's sick-tint face wash was given a
wider hue band than the other five poses, but it only partly follows the fur. Measured on
the finished files, the fur's median hue moves +45°, +94° and +145° for indigo, violet and
rose, while the face wash moves only +15°, +29° and +46°, so the face stays green in every
colorway. Green reads as "sick" on all four, so that's fine as it is. Cosmetic detail, not
something the integration needs to know, mentioned only so nobody mistakes it for a bug if
they ever regenerate these from the source renders.

**Superseded (2026-09-11):** zoo assigns the colorway per session, not per project: a
session gets a colour no other live session holds when it starts, and keeps it (PLAN.md,
locked decision 6). Telling concurrent monsters apart, the reason below, won out over a
project keeping its colour. The original recommendation, kept for the record:

**Selection logic (recommendation, not yet decided in code):** assign a colorway once per
project, not per session — session ids churn (a new one spins up per run), but the same
project should keep looking like the same monster across restarts so it reads as "your
project's monster," not a random palette each time. Hash whatever field identifies the
project/repo across sessions (project directory path is the obvious candidate) and take
it mod 4 against `[teal, indigo, violet, rose]`. Running 2-3 sessions at once was the
reason for adding these — the point is telling concurrent monsters apart at a glance, not
variety for its own sake.

## What's deliberately not in scope here

Only one species exists (this one). The roster idea (8-12 species) is real but not started —
phase 4 as scoped now is proving this one monster end to end, not building the roster.
Reduced-motion handling (`prefers-reduced-motion`) was respected in the rig for every
animation above; carry that over, it's a straightforward `animation: none !important` per
rule, not a design decision.
