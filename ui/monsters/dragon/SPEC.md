# Dragon monster: spec for the Cowork heartbeat

Second species, for Cowork heartbeat monsters (NOTES.md, Phase 5: Cowork heartbeat
monster). Designed by Safiyya, 2026-09-14: a red dragon with the zoo's scarf. It only
needs the states the heartbeat can show, so two poses cover it.

## Assets (this folder)

Transparent PNGs, background removed, cropped tight to the figure with a small pad, the
same way as `ui/monsters/scarf/`. Cut from Safiyya's design sheet
(`Gemini_Generated_Image_nzzpf8nzzpf8nzzp.jpeg`, 2816x1536: working on the left half,
sleeping on the right, labels below 90.5% of the height) with Apple Vision's subject lifting
(`VNGenerateForegroundInstanceMaskRequest`), 12px transparent pad. Light edge fringe:
3.7% (working) and 3.3% (sleeping) of opaque pixels, the scarf art's range. Different
aspect ratios are fine: the zoo stands every pose on the same bottom line
(`object-fit: contain`, bottom-anchored).

- `working.png` (1042x1294): standing, glasses on, typing on a laptop held in one hand
- `sleeping.png` (1084x919): curled up asleep, scarf trailing

No colorways: the dragon is always red. No blocked, errored or standing art.

## State to pose

```
working  -> working
done     -> sleeping          (held still, like a dismissed scarf monster)
unread   -> sleeping + badge  (the scarf monster's red unread badge)
```

A heartbeat monster never reaches spawned, blocked, errored or stale in practice; if one
did, it falls back to `working` for spawned and `sleeping` for the rest.

## Animation

Reuse the scarf keyframes: working holds still (Safiyya's call for the scarf monster),
sleeping uses `sleep-breathe 4.2s ease-in-out infinite` and holds still once the turn
is seen. The unread badge pulses as it does for scarf, centred at `left: 34%; top: 20%`
of the sleeping image (frame `--a: 1.1795`), which puts it on the ear beside the scarf,
clear of the face. No sleep Z's: for scarf those mean stale.

## Menu bar faces

Cropped from the poses at build time (`src-tauri/build/faces.rs`), 20pt, palette
`dragon` in the app's faces table:
- `idle` (working): the awake face, crop x 300, y 20, 500x540 of `working.png`, still
- `rest` (done): the sleeping face, crop x 20, y 40, 480x560 of `sleeping.png`, still
- `unread`: the sleeping face with the red dot, shaking (4 frames)
At 20pt the working face reads clearly; the sleeping face's closed eyes are faint and its
crop leaves a straight edge where it cuts the scarf. Check in the real menu bar before tuning.
