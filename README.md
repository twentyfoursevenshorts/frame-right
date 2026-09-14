# Framewright

A personal, local-first video editor: multi-track timeline, real trim/split/keyframes,
text + captions, filters/effects, audio mixing, and genuine (not simulated) canvas-based
export up to 4K. All processing happens in your browser — nothing is uploaded anywhere.

---

## 1. Running it

No build step, no `npm install` required — it's plain ES modules + CDN-hosted React.

```bash
cd framewright
python3 -m http.server 8080
# or: npx serve .
```

Open **http://localhost:8080**. (It must be served over http/https, not opened as a
`file://` URL — browsers block ES module imports and IndexedDB from the file protocol.)

**Requires a recent Chromium-based browser (Chrome/Edge) for full functionality** —
specifically `canvas.captureStream`, `MediaRecorder`, and (optionally) `SpeechRecognition`
for live caption transcription. Firefox supports editing/preview/export; live-mic
captions are Chrome/Edge only.

### Want a real npm/Vite build instead?
This was built dependency-light on purpose because the sandbox that generated it has no
network access to run `npm install`. If you have network access, converting it is
straightforward: `npm create vite@latest . -- --template react-ts`, move `src/*.js` into
`src/`, replace the `htm` tagged-template calls with real JSX (mechanical find/replace of
`` html`<Component prop=${x}>` `` → `<Component prop={x}>`), and add Tailwind via its
Vite plugin instead of the CDN script.

---

## 2. Architecture

```
index.html          — loads React/ReactDOM/htm/Tailwind from CDN, boots src/main.js
styles.css           — hand-written component classes layered on Tailwind utilities
src/
  main.js            — mounts <App/>
  app.js             — all UI: sidebar, media library, preview, timeline, properties,
                        export dialog. One file by necessity of the no-build setup,
                        but internally split into focused components.
  store.js           — project data model + pub/sub store + undo/redo history stack
  db.js              — IndexedDB wrapper (projects store + media blob store)
  media.js           — file import: type detection, metadata probing, thumbnail
                        generation, waveform decoding
  renderer.js         — renderFrame(): the ONE function that draws a composited frame.
                        Used by both live preview and export, so what you see is what
                        you get.
  export.js          — MediaRecorder-based export pipeline (video+audio capture)
  captions.js         — manual transcript → timed captions, live mic transcription,
                        caption style presets
```

**Data model** (`store.js`): a project has `settings`, `exportSettings`, a
`mediaLibrary` (probed metadata, not raw files), and `tracks[]` of type
`video | audio | text | caption | elements`, each holding `clips[]`. Every clip has a
stable id, timeline `start`/`duration`, source `trimIn`/`trimOut`, a transform
(position/scale/rotation/opacity), and an optional `keyframes` map per property.

**Rendering model**: the timeline is the edit-decision list; `renderer.js` interprets
it into pixels. Preview draws to an on-screen canvas every animation frame; export
draws the same function to an off-screen canvas at your chosen export resolution and
feeds it into `MediaRecorder`. This is why there's no separate "preview quality" vs.
"final quality" — they're the same code path.

---

## 3. How auto captions actually work (read before relying on this)

Real speech-to-text (e.g. Whisper) needs either a downloaded model or a network API
call. The environment this was built in has **no network access**, so there was no way
to fetch model weights or verify an API integration actually works — and per your
instructions, I won't fake a transcript to make the feature look more complete than it
is. So captions ship as two genuinely-working paths instead of one fake one:

1. **Manual transcript → auto-timed captions.** Type or paste your transcript in the
   Captions panel, select the clip it belongs to, and click "Apply." Framewright
   splits it into lines at your max-characters-per-line setting and distributes real
   timing across the clip's duration (word-length-weighted). You then drag each
   caption block on the timeline to fine-tune sync, same as a manual caption pass in
   any professional editor.
2. **Live mic transcription while recording a voiceover** (Chrome/Edge only), via the
   browser's built-in `SpeechRecognition` API — genuine on-the-fly speech recognition,
   not a mock, with results appended to the transcript field as you talk.

If you deploy this somewhere with network access, wiring in real whole-file
transcription is a single function to replace: `captions.js` is already shaped around
`{start, end, text}` segments, so a Whisper API call can populate that array directly
in place of `autoSplitTranscript`.

---

## 4. How 4K export actually works

Export renders your **actual source media** into an off-screen canvas sized to your
chosen export resolution (e.g. 3840×2160), not a scaled-up screenshot of the preview
UI. If your source clip is already 4K, its native pixels are drawn 1:1; if your source
is 1080p, it's upscaled the same way any consumer editor upscales sub-resolution
footage on a 4K timeline. `canvas.captureStream(fps)` + `MediaRecorder` then encodes
that literal canvas output, combined with a real mixed audio graph (per-clip
volume/fade via Web Audio `GainNode`s), into a video file.

**Honest limitation:** because `MediaRecorder` captures a live real-time stream, export
takes roughly as long as your video's own duration (a 2-minute edit takes ~2 minutes to
export) — there's no way to encode faster-than-real-time without a native encoder
process (ffmpeg) or a WASM ffmpeg core, and this sandbox had no network access to fetch
either. The container/codec is WebM (VP9+Opus) unless your specific browser build
exposes a working `video/mp4;codecs=avc1` MediaRecorder mode, in which case Framewright
uses that automatically. If you need guaranteed H.264 MP4, the cleanest upgrade path
(with network access) is `@ffmpeg/ffmpeg` (ffmpeg.wasm): keep the same real-time canvas
capture as an intermediate WebM, then run one `ffmpeg -i in.webm -c:v libx264 out.mp4`
pass client-side, or transcode server-side if you add a small local backend.

---

## 5. What's genuinely implemented vs. simplified

Everything below is real and testable, not decorative:

- Import (video/image/audio), drag-and-drop, media library with real thumbnails/waveforms
- Multi-track timeline: drag to move, edge-drag to trim, split at playhead, delete,
  duplicate, mute/lock/hide per track, zoom, snapless free placement
- Playback: play/pause, frame-step, scrub, keyboard shortcuts
- Transform per clip: position, scale, rotation, opacity, speed (0.25×–4×)
- Text layers: font (19 open fonts bundled), size, weight, italic, alignment, color,
  stroke, shadow, background, line spacing, full transform
- Filters (9 presets) and manual adjustments (brightness/contrast/saturation/blur),
  applied via real canvas `filter` compositing
- Audio: per-clip volume, fade in/out (via Web Audio gain automation), mute
- Elements: rectangle/circle/line/arrow shapes with full transform
- Keyframes: add/remove per property at the playhead, linear/eased interpolation,
  used by both preview and export
- Undo/redo, autosave to IndexedDB, project browser, first-run screen
- Export: real resolution/fps/quality/format options with live progress and cancel

Deliberately simplified, and stated as such rather than faked:

- **Transitions**: only automatic crossfade where two clips overlap on the same video
  track is implemented. Wipe/slide/glitch transition types are not yet built.
- **Masking**: not implemented in this pass (per your instruction to leave a genuinely
  absent advanced feature out rather than fake a control — the data model has room to
  add `clip.mask` later without breaking existing projects).
- **Reverse playback / speed ramping curves**: basic multiplier speeds (0.25×–4×) work;
  reverse and eased speed ramps are not implemented.
- **Noise reduction**: not implemented.
- Custom `.ttf`/`.otf` font upload: not wired up yet (the font list is fixed to the 19
  bundled Google Fonts); the UI is structured so adding a file-upload-to-`@font-face`
  path is additive, not a rewrite.

---

## 6. Testing notes

This was built in a sandboxed environment with no network access and no display/browser
runtime, so I could statically verify every module (`node --check` on all source files —
all pass) and trace each of your listed workflows (A–G) through the code path by hand,
but I could not drive an actual browser end-to-end here. Please treat your first import →
edit → export pass as the real smoke test, and tell me what breaks — the architecture
(single shared `renderFrame`, JSON-serializable project model) is deliberately set up so
fixes are localized rather than requiring a rewrite.

---

## 7. Adding things later

- **New filter preset**: add a CSS filter string to `FILTER_PRESETS` in `renderer.js`.
- **New font**: add its name to `FONTS` in `app.js` and a corresponding `@import`/`<link>`
  in `index.html`.
- **New transition type**: extend `renderFrame`'s video-track compositing loop in
  `renderer.js` to blend based on `clip.transitionIn.type`.
- **New effect**: same place — add to `adjustmentsToFilter` or as a new canvas filter
  branch.
- **Real Whisper transcription**: replace the body of caption ingestion in
  `CaptionsPanel` (`app.js`) with a call to your STT endpoint, producing the same
  `{start, end, text}` segment shape `autoSplitTranscript` already returns.
