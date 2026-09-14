import { html } from "./htm-react.js";
import { store, newClip, newProject, uid } from "./store.js";
import { db } from "./db.js";
import { importFile, rehydrateMediaUrl } from "./media.js";
import { renderFrame, totalDuration, FILTER_PRESETS } from "./renderer.js";
import { exportProject, extensionForMime } from "./export.js";
import { autoSplitTranscript, CAPTION_PRESETS, isLiveSpeechRecognitionSupported, startLiveTranscription } from "./captions.js";

const { useState, useEffect, useRef, useCallback, useMemo } = React;

const FONTS = [
  "Inter", "Roboto", "Open Sans", "Montserrat", "Poppins", "Oswald", "Bebas Neue",
  "Playfair Display", "Lato", "Raleway", "Anton", "Archivo", "Barlow", "Merriweather",
  "Ubuntu", "Nunito", "Space Grotesk", "DM Sans", "Plus Jakarta Sans",
];

const ASPECT_PRESETS = {
  "16:9": { w: 1920, h: 1080, label: "YouTube / Landscape" },
  "9:16": { w: 1080, h: 1920, label: "TikTok / Reels / Shorts" },
  "1:1": { w: 1080, h: 1080, label: "Square" },
  "4:5": { w: 1080, h: 1350, label: "Instagram Feed" },
  "4:3": { w: 1440, h: 1080, label: "Classic" },
};

function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  const ms = Math.floor((s % 1) * 100).toString().padStart(2, "0");
  return `${m}:${sec}.${ms}`;
}

function useStore() {
  const [state, setState] = useState(store.get());
  useEffect(() => store.subscribe(setState), []);
  return state;
}

// ---------------------------------------------------------------------------
// Media element pool: lazily builds/reuses <video>/<audio>/<img> elements for
// every media item so the preview can draw+play them without re-creating DOM
// nodes every frame.
// ---------------------------------------------------------------------------
function useMediaPool(mediaLibrary) {
  const poolRef = useRef(new Map());
  useEffect(() => {
    mediaLibrary.forEach(async (item) => {
      if (poolRef.current.has(item.mediaId)) return;
      let url = item.objectUrl;
      if (!url) url = await rehydrateMediaUrl(item.mediaId);
      if (!url) return;
      let el;
      if (item.type === "image") {
        el = new Image();
        el.src = url;
      } else {
        el = document.createElement(item.type === "audio" ? "audio" : "video");
        el.src = url;
        el.preload = "auto";
        el.crossOrigin = "anonymous";
      }
      poolRef.current.set(item.mediaId, el);
    });
  }, [mediaLibrary]);
  return poolRef;
}

// =============================================================================
// App
// =============================================================================
export function App() {
  const state = useStore();
  const { project, selection, playhead, isPlaying, zoom } = state;
  const [screen, setScreen] = useState("start"); // start | editor
  const [activeTab, setActiveTab] = useState("media");
  const [showExport, setShowExport] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [error, setError] = useState(null);

  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const playStartRef = useRef({ wall: 0, playhead: 0 });
  const mediaPool = useMediaPool(project.mediaLibrary);

  const duration = useMemo(() => Math.max(totalDuration(project), 1), [project]);

  // ---------------- persistence ----------------
  useEffect(() => {
    if (screen !== "editor") return;
    setSaveStatus("Saving…");
    const t = setTimeout(async () => {
      await db.saveProject(serializableProject(project));
      setSaveStatus("Saved");
    }, 600);
    return () => clearTimeout(t);
  }, [project, screen]);

  function serializableProject(p) {
    // strip in-memory-only objectUrl fields before persisting media library entries
    return { ...p, mediaLibrary: p.mediaLibrary.map(({ objectUrl, ...rest }) => rest) };
  }

  // ---------------- keyboard shortcuts ----------------
  useEffect(() => {
    function onKey(e) {
      if (screen !== "editor") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "s" || e.key === "S") {
        splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selection) deleteClip(selection);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
        store.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        store.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (selection) duplicateClip(selection);
      } else if (e.key === "ArrowLeft") {
        seek(Math.max(0, playhead - (e.shiftKey ? 1 : 1 / project.settings.fps)));
      } else if (e.key === "ArrowRight") {
        seek(Math.min(duration, playhead + (e.shiftKey ? 1 : 1 / project.settings.fps)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------- playback loop ----------------
  function seek(t) {
    store.setUI({ playhead: Math.max(0, Math.min(duration, t)) });
  }

  function togglePlay() {
    if (isPlaying) {
      store.setUI({ isPlaying: false });
    } else {
      playStartRef.current = { wall: performance.now(), playhead };
      store.setUI({ isPlaying: true });
    }
  }

  useEffect(() => {
    function draw(t) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = project.settings.width;
      canvas.height = project.settings.height;
      const ctx = canvas.getContext("2d");
      renderFrame(ctx, project, t, mediaPool.current);
    }

    if (!isPlaying) {
      // sync media elements to the current scrub position (paused)
      project.tracks.forEach((track) => {
        track.clips.forEach((clip) => {
          const el = mediaPool.current.get(clip.mediaId);
          if (!el || el.tagName === "IMG") return;
          const active = playhead >= clip.start && playhead < clip.start + clip.duration;
          if (active) {
            const local = (playhead - clip.start) * (clip.speed || 1) + clip.trimIn;
            if (Math.abs(el.currentTime - local) > 0.08) el.currentTime = local;
          }
          if (!el.paused) el.pause();
        });
      });
      draw(playhead);
      return;
    }

    function loop() {
      const elapsed = (performance.now() - playStartRef.current.wall) / 1000;
      const t = playStartRef.current.playhead + elapsed;
      if (t >= duration) {
        store.setUI({ isPlaying: false, playhead: duration });
        return;
      }
      project.tracks.forEach((track) => {
        if (track.hidden || track.muted) return;
        track.clips.forEach((clip) => {
          const el = mediaPool.current.get(clip.mediaId);
          if (!el || el.tagName === "IMG") return;
          const active = t >= clip.start && t < clip.start + clip.duration;
          if (active) {
            const local = (t - clip.start) * (clip.speed || 1) + clip.trimIn;
            if (Math.abs(el.currentTime - local) > 0.25) el.currentTime = local;
            el.playbackRate = clip.speed || 1;
            el.muted = clip.muted || track.type === "video"; // video elements stay muted in preview to avoid double audio; real mixing happens on export
            if (track.type === "audio" && el.paused) el.play().catch(() => {});
            if (track.type === "video" && !el.paused) el.pause(); // video preview is drawn frame-by-frame, no need to play
          } else if (!el.paused) {
            el.pause();
          }
        });
      });
      draw(t);
      store.setUI({ playhead: t });
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line
  }, [isPlaying, project, duration]);

  // ---------------- media import ----------------
  async function handleFiles(fileList) {
    for (const file of Array.from(fileList)) {
      try {
        const item = await importFile(file);
        store.update((p) => ({ ...p, mediaLibrary: [...p.mediaLibrary, item] }));
      } catch (e) {
        setError(e.message);
      }
    }
  }

  // ---------------- timeline operations ----------------
  function trackFor(mediaType) {
    if (mediaType === "video" || mediaType === "image") return "video";
    if (mediaType === "audio") return "audio";
    return "video";
  }

  function addMediaToTimeline(item, atTime) {
    store.update((p) => {
      const trackType = trackFor(item.type);
      let track = p.tracks.find((t) => t.type === trackType && !t.locked);
      if (!track) {
        track = { id: uid("track"), type: trackType, name: `${trackType} ${p.tracks.length + 1}`, clips: [], muted: false, locked: false, hidden: false };
        p.tracks.push(track);
      }
      const start = atTime ?? Math.max(0, ...track.clips.map((c) => c.start + c.duration), 0);
      const dur = item.type === "image" ? 5 : item.duration;
      const clip = newClip({
        mediaId: item.mediaId,
        start,
        duration: dur,
        trimIn: 0,
        trimOut: dur,
      });
      track.clips.push(clip);
      return p;
    });
  }

  function addTextClip() {
    store.update((p) => {
      let track = p.tracks.find((t) => t.type === "text");
      const start = playhead;
      const clip = newClip({
        start,
        duration: 3,
        text: "Your text here",
        textStyle: { font: "Inter", size: 64, color: "#ffffff", align: "center", bold: true, lineSpacing: 1.2 },
      });
      track.clips.push(clip);
      store.setUI({ selection: clip.id });
      return p;
    });
  }

  function addElementClip(shape) {
    store.update((p) => {
      let track = p.tracks.find((t) => t.type === "elements");
      if (!track) {
        track = { id: uid("track"), type: "elements", name: "Elements", clips: [], muted: false, locked: false, hidden: false };
        p.tracks.push(track);
      }
      const clip = newClip({ start: playhead, duration: 3, elementShape: shape, elementColor: "#7c5cff" });
      track.clips.push(clip);
      store.setUI({ selection: clip.id });
      return p;
    });
  }

  function selectedClip() {
    if (!selection) return null;
    for (const t of project.tracks) {
      const c = t.clips.find((c) => c.id === selection);
      if (c) return { clip: c, track: t };
    }
    return null;
  }

  function updateSelectedClip(patch) {
    if (!selection) return;
    store.update((p) => {
      for (const t of p.tracks) {
        const c = t.clips.find((c) => c.id === selection);
        if (c) Object.assign(c, patch);
      }
      return p;
    }, { pushHistory: false });
  }

  function commitHistory() {
    store.update((p) => p);
  }

  function splitAtPlayhead() {
    if (!selection) return;
    store.update((p) => {
      for (const t of p.tracks) {
        const idx = t.clips.findIndex((c) => c.id === selection);
        if (idx === -1) continue;
        const c = t.clips[idx];
        if (playhead <= c.start || playhead >= c.start + c.duration) return p;
        const localSplit = (playhead - c.start) * (c.speed || 1);
        const first = { ...c, id: uid("clip"), duration: playhead - c.start, trimOut: c.trimIn + localSplit };
        const second = { ...c, id: uid("clip"), start: playhead, duration: c.duration - (playhead - c.start), trimIn: c.trimIn + localSplit };
        t.clips.splice(idx, 1, first, second);
      }
      return p;
    });
  }

  function deleteClip(clipId) {
    store.update((p) => {
      p.tracks.forEach((t) => (t.clips = t.clips.filter((c) => c.id !== clipId)));
      return p;
    });
    store.setUI({ selection: null });
  }

  function duplicateClip(clipId) {
    store.update((p) => {
      for (const t of p.tracks) {
        const c = t.clips.find((c) => c.id === clipId);
        if (c) {
          const copy = { ...c, id: uid("clip"), start: c.start + c.duration };
          t.clips.push(copy);
        }
      }
      return p;
    });
  }

  function addTrack(type) {
    store.update((p) => {
      p.tracks.push({ id: uid("track"), type, name: `${type} ${p.tracks.filter((t) => t.type === type).length + 1}`, clips: [], muted: false, locked: false, hidden: false });
      return p;
    });
  }

  function toggleTrackFlag(trackId, flag) {
    store.update((p) => {
      const t = p.tracks.find((t) => t.id === trackId);
      if (t) t[flag] = !t[flag];
      return p;
    }, { pushHistory: false });
  }

  // ---------------- project lifecycle ----------------
  async function createNewProject(aspect) {
    const p = newProject("Untitled Project");
    const preset = ASPECT_PRESETS[aspect];
    p.settings.width = preset.w;
    p.settings.height = preset.h;
    p.settings.aspectPreset = aspect;
    store.loadProject(p);
    await db.saveProject(p);
    setScreen("editor");
  }

  async function openProject(p) {
    store.loadProject(p);
    setScreen("editor");
  }

  const sel = selectedClip();

  if (screen === "start") {
    return html`<${StartScreen} onCreate=${createNewProject} onOpen=${openProject} onImportThenCreate=${async (files, aspect) => {
      await createNewProject(aspect);
      await handleFiles(files);
    }} />`;
  }

  return html`
    <div class="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-200 overflow-hidden">
      <${TopBar}
        project=${project}
        saveStatus=${saveStatus}
        onExport=${() => setShowExport(true)}
        onUndo=${() => store.undo()}
        onRedo=${() => store.redo()}
        onHome=${() => setScreen("start")}
        onRename=${(name) => store.update((p) => ({ ...p, name }))}
      />
      <div class="flex flex-1 min-h-0">
        <${Sidebar} activeTab=${activeTab} setActiveTab=${setActiveTab} />
        <${LeftPanel}
          activeTab=${activeTab}
          project=${project}
          onFiles=${handleFiles}
          onAddMedia=${(item) => addMediaToTimeline(item)}
          onAddText=${addTextClip}
          onAddElement=${addElementClip}
          onAddTrack=${addTrack}
        />
        <div class="flex-1 flex flex-col min-w-0">
          <${PreviewArea}
            canvasRef=${canvasRef}
            project=${project}
            playhead=${playhead}
            duration=${duration}
            isPlaying=${isPlaying}
            onTogglePlay=${togglePlay}
            onSeek=${seek}
          />
          <${Timeline}
            project=${project}
            playhead=${playhead}
            duration=${duration}
            zoom=${zoom}
            selection=${selection}
            onSeek=${seek}
            onSelect=${(id) => store.setUI({ selection: id })}
            onZoom=${(z) => store.setUI({ zoom: z })}
            onSplit=${splitAtPlayhead}
            onDelete=${deleteClip}
            onDuplicate=${duplicateClip}
            onToggleTrackFlag=${toggleTrackFlag}
            onDropMedia=${(item, trackId, time) => {
              store.update((p) => {
                const track = p.tracks.find((t) => t.id === trackId);
                if (!track || track.locked) return p;
                const dur = item.type === "image" ? 5 : item.duration;
                track.clips.push(newClip({ mediaId: item.mediaId, start: Math.max(0, time), duration: dur, trimOut: dur }));
                return p;
              });
            }}
            onMoveClip=${(clipId, newStart) => {
              store.update((p) => {
                for (const t of p.tracks) {
                  const c = t.clips.find((c) => c.id === clipId);
                  if (c) c.start = Math.max(0, newStart);
                }
                return p;
              }, { pushHistory: false });
            }}
            onCommit=${commitHistory}
            onTrimClip=${(clipId, edge, newVal) => {
              store.update((p) => {
                for (const t of p.tracks) {
                  const c = t.clips.find((c) => c.id === clipId);
                  if (!c) continue;
                  if (edge === "start") {
                    const delta = newVal - c.start;
                    c.start = newVal;
                    c.duration -= delta;
                    c.trimIn += delta * (c.speed || 1);
                  } else {
                    c.duration = Math.max(0.1, newVal - c.start);
                  }
                }
                return p;
              }, { pushHistory: false });
            }}
          />
        </div>
        <${PropertiesPanel}
          selected=${sel}
          project=${project}
          onChange=${updateSelectedClip}
          onCommit=${commitHistory}
        />
      </div>
      ${showExport && html`<${ExportDialog} project=${project} onClose=${() => setShowExport(false)} />`}
      ${error && html`<${ErrorToast} message=${error} onClose=${() => setError(null)} />`}
    </div>
  `;
}

// =============================================================================
// Start / onboarding screen (section 39)
// =============================================================================
function StartScreen({ onCreate, onOpen, onImportThenCreate }) {
  const [recent, setRecent] = useState([]);
  const [aspect, setAspect] = useState("16:9");
  const fileRef = useRef();

  useEffect(() => {
    db.listProjects().then((list) => setRecent(list.sort((a, b) => b.updatedAt - a.updatedAt)));
  }, []);

  return html`
    <div class="h-screen w-screen bg-neutral-950 text-neutral-200 flex flex-col items-center justify-center gap-10 px-6">
      <div class="text-center">
        <div class="flex items-center justify-center gap-3 mb-2">
          <${Logo} size=${40} />
          <h1 class="text-3xl font-semibold tracking-tight text-neutral-50">Framewright</h1>
        </div>
        <p class="text-neutral-400">A personal, local-first video editor.</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-3xl">
        <div class="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
          <h2 class="font-medium mb-3 text-neutral-100">New project</h2>
          <div class="space-y-2 mb-4">
            ${Object.entries(ASPECT_PRESETS).map(([key, v]) => html`
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="aspect" checked=${aspect === key} onChange=${() => setAspect(key)} />
                <span class="text-neutral-300">${key} <span class="text-neutral-500">— ${v.label}</span></span>
              </label>
            `)}
          </div>
          <button class="btn-primary w-full" onClick=${() => onCreate(aspect)}>Create New Project</button>
        </div>

        <div class="bg-neutral-900 border border-neutral-800 rounded-lg p-5">
          <h2 class="font-medium mb-3 text-neutral-100">Open project</h2>
          ${recent.length === 0
            ? html`<p class="text-sm text-neutral-500">No saved projects yet.</p>`
            : html`<div class="space-y-2 max-h-40 overflow-auto">
                ${recent.map((p) => html`
                  <button class="w-full text-left text-sm px-3 py-2 rounded bg-neutral-800 hover:bg-neutral-700" onClick=${() => onOpen(p)}>
                    ${p.name} <span class="text-neutral-500 text-xs">— ${new Date(p.updatedAt).toLocaleString()}</span>
                  </button>
                `)}
              </div>`}
        </div>

        <div class="bg-neutral-900 border border-neutral-800 rounded-lg p-5 flex flex-col">
          <h2 class="font-medium mb-3 text-neutral-100">Import media</h2>
          <p class="text-sm text-neutral-500 mb-4">Start a new project directly from your footage.</p>
          <input ref=${fileRef} type="file" multiple class="hidden" onChange=${(e) => e.target.files.length && onImportThenCreate(e.target.files, aspect)} />
          <button class="btn-secondary mt-auto" onClick=${() => fileRef.current.click()}>Choose Files…</button>
        </div>
      </div>
    </div>
  `;
}

function Logo({ size = 24 }) {
  return html`
    <svg width=${size} height=${size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#6d4fff" />
      <path d="M9 10h9a4 4 0 010 8h-9" stroke="white" stroke-width="2.2" stroke-linecap="round" />
      <circle cx="22.5" cy="21" r="2.5" fill="white" />
    </svg>
  `;
}

// =============================================================================
// Top bar
// =============================================================================
function TopBar({ project, saveStatus, onExport, onUndo, onRedo, onHome, onRename }) {
  const [editing, setEditing] = useState(false);
  return html`
    <div class="h-12 flex items-center justify-between px-3 border-b border-neutral-800 bg-neutral-925 shrink-0" style="background:#111114">
      <div class="flex items-center gap-3">
        <button class="p-1 hover:bg-neutral-800 rounded" onClick=${onHome} title="Back to start"><${Logo} size=${22} /></button>
        ${editing
          ? html`<input autoFocus class="bg-neutral-800 rounded px-2 py-0.5 text-sm" value=${project.name}
              onBlur=${(e) => { onRename(e.target.value); setEditing(false); }}
              onKeyDown=${(e) => e.key === "Enter" && e.target.blur()} />`
          : html`<span class="text-sm text-neutral-300 cursor-text" onClick=${() => setEditing(true)}>${project.name}</span>`}
        <span class="text-xs text-neutral-600">${project.settings.width}×${project.settings.height} · ${project.settings.fps}fps</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-neutral-500 w-16">${saveStatus}</span>
        <button class="icon-btn" title="Undo (Ctrl+Z)" onClick=${onUndo}>↶</button>
        <button class="icon-btn" title="Redo (Ctrl+Shift+Z)" onClick=${onRedo}>↷</button>
        <button class="btn-primary" onClick=${onExport}>Export</button>
      </div>
    </div>
  `;
}

function ErrorToast({ message, onClose }) {
  return html`
    <div class="fixed bottom-4 right-4 bg-red-950 border border-red-800 text-red-200 text-sm px-4 py-3 rounded-lg shadow-lg max-w-sm">
      <div class="flex justify-between gap-3">
        <span>${message}</span>
        <button class="text-red-400" onClick=${onClose}>✕</button>
      </div>
    </div>
  `;
}

// =============================================================================
// Sidebar (icon tabs)
// =============================================================================
const TABS = [
  ["media", "Media"], ["audio", "Audio"], ["text", "Text"], ["captions", "Captions"],
  ["stickers", "Elements"], ["effects", "Effects"], ["filters", "Filters"], ["transitions", "Transitions"],
];

function Sidebar({ activeTab, setActiveTab }) {
  return html`
    <div class="w-16 shrink-0 border-r border-neutral-800 flex flex-col items-center py-2 gap-1 bg-neutral-925" style="background:#0d0d10">
      ${TABS.map(([key, label]) => html`
        <button
          class="w-14 py-2 rounded text-[10px] flex flex-col items-center gap-1 ${activeTab === key ? "bg-violet-600/20 text-violet-300" : "text-neutral-500 hover:bg-neutral-800"}"
          onClick=${() => setActiveTab(key)}>
          <span class="text-base leading-none">${TAB_ICON[key]}</span>
          ${label}
        </button>
      `)}
    </div>
  `;
}
const TAB_ICON = { media: "▤", audio: "♪", text: "T", captions: "▭", stickers: "◆", effects: "✦", filters: "◑", transitions: "⇄" };

// =============================================================================
// Left contextual panel
// =============================================================================
function LeftPanel({ activeTab, project, onFiles, onAddMedia, onAddText, onAddElement, onAddTrack }) {
  const dropRef = useRef();
  const [dragOver, setDragOver] = useState(false);

  if (activeTab === "media" || activeTab === "audio") {
    const items = project.mediaLibrary.filter((m) => (activeTab === "audio" ? m.type === "audio" : m.type !== "audio"));
    return html`
      <div class="w-72 shrink-0 border-r border-neutral-800 flex flex-col p-3 bg-neutral-950">
        <div
          class="border-2 border-dashed rounded-lg p-4 text-center text-xs text-neutral-500 mb-3 ${dragOver ? "border-violet-500 text-violet-300" : "border-neutral-800"}"
          onDragOver=${(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave=${() => setDragOver(false)}
          onDrop=${(e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }}
        >
          Drag & drop files here
          <div class="mt-2">
            <label class="btn-secondary inline-block cursor-pointer text-xs">
              Browse…
              <input type="file" multiple class="hidden" onChange=${(e) => onFiles(e.target.files)} />
            </label>
          </div>
        </div>
        <div class="flex-1 overflow-auto grid grid-cols-2 gap-2 content-start">
          ${items.map((item) => html`
            <div
              draggable="true"
              onDragStart=${(e) => e.dataTransfer.setData("application/json", JSON.stringify({ libItemId: item.id }))}
              class="bg-neutral-900 rounded-md overflow-hidden border border-neutral-800 hover:border-violet-600 cursor-pointer group"
              onClick=${() => onAddMedia(item)}
              title="Click to add to timeline, or drag onto a track">
              <div class="aspect-video bg-neutral-800 flex items-center justify-center overflow-hidden">
                ${item.thumbnail
                  ? html`<img src=${item.thumbnail} class="w-full h-full object-cover" />`
                  : html`<span class="text-2xl text-neutral-600">${item.type === "audio" ? "♪" : "▤"}</span>`}
              </div>
              <div class="px-1.5 py-1">
                <div class="text-[11px] truncate text-neutral-300">${item.name}</div>
                <div class="text-[10px] text-neutral-500">${item.duration ? item.duration.toFixed(1) + "s" : ""} ${item.width ? `· ${item.width}×${item.height}` : ""}</div>
              </div>
            </div>
          `)}
          ${items.length === 0 && html`<p class="col-span-2 text-xs text-neutral-600 text-center mt-4">No media yet.</p>`}
        </div>
      </div>
    `;
  }

  if (activeTab === "text") {
    return html`
      <div class="w-72 shrink-0 border-r border-neutral-800 p-3 bg-neutral-950">
        <button class="btn-primary w-full mb-3" onClick=${onAddText}>+ Add Text Layer</button>
        <p class="text-xs text-neutral-500 leading-relaxed">Adds a text layer at the playhead. Select it on the timeline to edit font, color, stroke, shadow, animation and position in the right panel.</p>
        <h3 class="text-xs uppercase tracking-wide text-neutral-500 mt-4 mb-2">Fonts available</h3>
        <div class="grid grid-cols-2 gap-1">
          ${FONTS.map((f) => html`<div class="text-[11px] text-neutral-400 truncate" style="font-family:${f}">${f}</div>`)}
        </div>
      </div>
    `;
  }

  if (activeTab === "stickers") {
    return html`
      <div class="w-72 shrink-0 border-r border-neutral-800 p-3 bg-neutral-950">
        <h3 class="text-xs uppercase tracking-wide text-neutral-500 mb-2">Shapes</h3>
        <div class="grid grid-cols-2 gap-2">
          ${["rect", "circle", "line", "arrow"].map((s) => html`
            <button class="bg-neutral-900 border border-neutral-800 rounded-md py-4 hover:border-violet-600 text-neutral-300 text-xs capitalize" onClick=${() => onAddElement(s)}>${s}</button>
          `)}
        </div>
      </div>
    `;
  }

  if (activeTab === "captions") {
    return html`<${CaptionsPanel} project=${project} />`;
  }

  if (activeTab === "filters") {
    return html`
      <div class="w-72 shrink-0 border-r border-neutral-800 p-3 bg-neutral-950">
        <p class="text-xs text-neutral-500 mb-2">Select a clip, then click a filter preset. Fine-tune in the right panel under Adjustments.</p>
        <p class="text-xs text-neutral-600">Filters apply per-clip — select a clip on the timeline first.</p>
      </div>
    `;
  }

  if (activeTab === "effects") {
    return html`
      <div class="w-72 shrink-0 border-r border-neutral-800 p-3 bg-neutral-950">
        <p class="text-xs text-neutral-500">Select a clip to reveal Adjustments (blur, brightness, contrast, saturation) in the right panel — effects are applied live via the canvas render pipeline.</p>
      </div>
    `;
  }

  if (activeTab === "transitions") {
    return html`
      <div class="w-72 shrink-0 border-r border-neutral-800 p-3 bg-neutral-950">
        <p class="text-xs text-neutral-500 mb-2">Drag two clips next to each other on the same video track — Framewright automatically crossfades the overlap region.</p>
        <p class="text-xs text-neutral-600">Additional transition types (wipe, slide, glitch) are on the roadmap — see README limitations.</p>
      </div>
    `;
  }

  return null;
}

function CaptionsPanel({ project }) {
  const [transcript, setTranscript] = useState("");
  const [maxChars, setMaxChars] = useState(42);
  const [lang, setLang] = useState("en-US");
  const [recording, setRecording] = useState(false);
  const recRef = useRef(null);

  function applyTranscript() {
    const sel = store.get().selection;
    let clip = null, track = null;
    for (const t of project.tracks) {
      const c = t.clips.find((c) => c.id === sel);
      if (c) { clip = c; track = t; }
    }
    if (!clip) {
      alert("Select a video or audio clip on the timeline first, then apply the transcript.");
      return;
    }
    const segments = autoSplitTranscript(transcript, clip.duration, maxChars);
    store.update((p) => {
      let capTrack = p.tracks.find((t) => t.type === "caption");
      if (!capTrack) {
        capTrack = { id: uid("track"), type: "caption", name: "Captions", clips: [], muted: false, locked: false, hidden: false };
        p.tracks.push(capTrack);
      }
      segments.forEach((seg) => {
        capTrack.clips.push(newClip({ start: clip.start + seg.start, duration: Math.max(0.3, seg.end - seg.start), captionText: seg.text }));
      });
      return p;
    });
  }

  function toggleLiveRecording() {
    if (recording) {
      recRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      recRef.current = startLiveTranscription(lang, ({ text, end }) => {
        setTranscript((prev) => (prev ? prev + " " + text : text));
      });
      setRecording(true);
    } catch (e) {
      alert(e.message);
    }
  }

  function applyStylePreset(key) {
    store.update((p) => ({ ...p, captionStyle: { ...p.captionStyle, ...CAPTION_PRESETS[key], preset: key } }));
  }

  return html`
    <div class="w-72 shrink-0 border-r border-neutral-800 p-3 bg-neutral-950 overflow-auto">
      <h3 class="text-xs uppercase tracking-wide text-neutral-500 mb-2">Transcript</h3>
      <textarea
        class="w-full h-24 bg-neutral-900 border border-neutral-800 rounded p-2 text-xs text-neutral-200 resize-none"
        placeholder="Type or paste your transcript, or record live below…"
        value=${transcript}
        onChange=${(e) => setTranscript(e.target.value)}
      />
      <div class="flex items-center gap-2 mt-2">
        <label class="text-[11px] text-neutral-500">Max chars/line</label>
        <input type="number" class="w-14 bg-neutral-900 border border-neutral-800 rounded px-1 text-xs" value=${maxChars} onChange=${(e) => setMaxChars(+e.target.value)} />
      </div>
      <button class="btn-primary w-full mt-2 text-xs" onClick=${applyTranscript}>Apply to selected clip →</button>

      <div class="mt-4 pt-3 border-t border-neutral-800">
        <h3 class="text-xs uppercase tracking-wide text-neutral-500 mb-2">Live transcription (mic)</h3>
        ${isLiveSpeechRecognitionSupported()
          ? html`
              <button class="w-full text-xs rounded py-2 ${recording ? "bg-red-600" : "bg-neutral-800 hover:bg-neutral-700"}" onClick=${toggleLiveRecording}>
                ${recording ? "● Stop live transcription" : "Start live transcription"}
              </button>
              <p class="text-[10px] text-neutral-600 mt-1">Uses your browser's built-in speech recognition while you talk — appends to the transcript above in real time.</p>
            `
          : html`<p class="text-[10px] text-neutral-600">Live transcription needs Chrome or Edge. Use the manual transcript field instead.</p>`}
      </div>

      <div class="mt-4 pt-3 border-t border-neutral-800">
        <h3 class="text-xs uppercase tracking-wide text-neutral-500 mb-2">Style preset</h3>
        <div class="grid grid-cols-2 gap-1.5">
          ${Object.keys(CAPTION_PRESETS).map((key) => html`
            <button class="text-[11px] rounded px-2 py-1.5 border ${project.captionStyle.preset === key ? "border-violet-500 text-violet-300" : "border-neutral-800 text-neutral-400 hover:border-neutral-600"}"
              onClick=${() => applyStylePreset(key)}>${key}</button>
          `)}
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// Preview
// =============================================================================
function PreviewArea({ canvasRef, project, playhead, duration, isPlaying, onTogglePlay, onSeek }) {
  const wrapRef = useRef();
  const aspect = project.settings.width / project.settings.height;

  return html`
    <div class="flex-1 min-h-0 flex flex-col items-center justify-center bg-[#08080a] p-4">
      <div ref=${wrapRef} class="relative bg-black shadow-2xl" style="aspect-ratio:${aspect}; max-height:100%; max-width:100%; height:100%;">
        <canvas ref=${canvasRef} class="w-full h-full object-contain block" />
      </div>
      <div class="flex items-center gap-3 mt-3 text-neutral-300">
        <button class="icon-btn" onClick=${() => onSeek(0)} title="Go to start">⏮</button>
        <button class="icon-btn" onClick=${() => onSeek(Math.max(0, playhead - 1 / project.settings.fps))} title="Previous frame">◀|</button>
        <button class="icon-btn text-lg" onClick=${onTogglePlay} title="Play/Pause (Space)">${isPlaying ? "⏸" : "▶"}</button>
        <button class="icon-btn" onClick=${() => onSeek(Math.min(duration, playhead + 1 / project.settings.fps))} title="Next frame">|▶</button>
        <span class="text-xs font-mono text-neutral-400 w-28">${fmtTime(playhead)} / ${fmtTime(duration)}</span>
      </div>
    </div>
  `;
}

// =============================================================================
// Timeline
// =============================================================================
function Timeline({ project, playhead, duration, zoom, selection, onSeek, onSelect, onZoom, onSplit, onDelete, onDuplicate, onToggleTrackFlag, onDropMedia, onMoveClip, onTrimClip, onCommit }) {
  const rulerRef = useRef();
  const pxPerSec = zoom;
  const trackHeight = 52;

  function timeFromX(clientX, container) {
    const rect = container.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / pxPerSec);
  }

  return html`
    <div class="h-64 border-t border-neutral-800 flex flex-col bg-neutral-950 shrink-0">
      <div class="h-9 flex items-center gap-2 px-3 border-b border-neutral-900 text-neutral-400">
        <button class="icon-btn" onClick=${onSplit} title="Split (S)">✂</button>
        <button class="icon-btn" onClick=${() => selection && onDuplicate(selection)} title="Duplicate (Ctrl+D)">⧉</button>
        <button class="icon-btn" onClick=${() => selection && onDelete(selection)} title="Delete (Del)">🗑</button>
        <div class="flex-1"></div>
        <span class="text-[11px]">Zoom</span>
        <input type="range" min="20" max="240" value=${zoom} onChange=${(e) => onZoom(+e.target.value)} class="w-28" />
      </div>
      <div class="flex-1 flex min-h-0">
        <div class="w-32 shrink-0 border-r border-neutral-900 overflow-y-auto">
          <div class="h-6"></div>
          ${project.tracks.map((track) => html`
            <div class="flex items-center gap-1 px-2 border-b border-neutral-900 text-[11px] text-neutral-400" style="height:${trackHeight}px">
              <span class="truncate flex-1">${track.name}</span>
              <button class="opacity-70 hover:opacity-100" title="Mute" onClick=${() => onToggleTrackFlag(track.id, "muted")}>${track.muted ? "🔇" : "🔊"}</button>
              <button class="opacity-70 hover:opacity-100" title="Lock" onClick=${() => onToggleTrackFlag(track.id, "locked")}>${track.locked ? "🔒" : "🔓"}</button>
              <button class="opacity-70 hover:opacity-100" title="Hide" onClick=${() => onToggleTrackFlag(track.id, "hidden")}>${track.hidden ? "🙈" : "👁"}</button>
            </div>
          `)}
        </div>
        <div class="flex-1 overflow-auto relative" id="tl-scroll"
          onClick=${(e) => {
            if (e.target.dataset.ruler) onSeek(timeFromX(e.clientX, e.currentTarget));
          }}>
          <div class="h-6 sticky top-0 bg-neutral-950 border-b border-neutral-900 relative z-10" data-ruler="1"
            style="width:${Math.max(1000, duration * pxPerSec + 200)}px"
            onMouseDown=${(e) => onSeek(timeFromX(e.clientX, e.currentTarget))}>
            ${rulerTicks(duration, pxPerSec)}
          </div>
          <div class="relative" style="width:${Math.max(1000, duration * pxPerSec + 200)}px">
            ${project.tracks.map((track) => html`
              <${TrackRow}
                track=${track}
                pxPerSec=${pxPerSec}
                height=${trackHeight}
                selection=${selection}
                onSelect=${onSelect}
                onDropMedia=${onDropMedia}
                onMoveClip=${onMoveClip}
                onTrimClip=${onTrimClip}
                onCommit=${onCommit}
              />
            `)}
            <div class="absolute top-0 bottom-0 w-px bg-violet-500 z-20 pointer-events-none" style="left:${playhead * pxPerSec}px; height:${project.tracks.length * trackHeight + 24}px">
              <div class="w-2.5 h-2.5 bg-violet-500 rotate-45 -ml-[5px] -mt-1"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function rulerTicks(duration, pxPerSec) {
  const step = pxPerSec < 40 ? 10 : pxPerSec < 90 ? 5 : 1;
  const ticks = [];
  for (let s = 0; s <= duration + 10; s += step) {
    ticks.push(html`<div class="absolute top-0 text-[9px] text-neutral-600 border-l border-neutral-800 h-full pl-1" style="left:${s * pxPerSec}px">${fmtTime(s).slice(0, 5)}</div>`);
  }
  return ticks;
}

function TrackRow({ track, pxPerSec, height, selection, onSelect, onDropMedia, onMoveClip, onTrimClip, onCommit }) {
  const rowRef = useRef();
  return html`
    <div ref=${rowRef} class="relative border-b border-neutral-900" style="height:${height}px"
      onDragOver=${(e) => e.preventDefault()}
      onDrop=${(e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData("application/json");
        if (!data) return;
        const { libItemId } = JSON.parse(data);
        const rect = rowRef.current.getBoundingClientRect();
        const time = Math.max(0, (e.clientX - rect.left) / pxPerSec);
        const item = store.get().project.mediaLibrary.find((m) => m.id === libItemId);
        if (item) onDropMedia(item, track.id, time);
      }}>
      ${track.clips.map((clip) => html`
        <${ClipView} key=${clip.id} clip=${clip} track=${track} pxPerSec=${pxPerSec} height=${height}
          selected=${selection === clip.id} onSelect=${onSelect} onMoveClip=${onMoveClip} onTrimClip=${onTrimClip} onCommit=${onCommit} />
      `)}
    </div>
  `;
}

const TRACK_COLOR = { video: "#3b3277", audio: "#1f5f52", text: "#5a4326", caption: "#4a2b4a", elements: "#2b3a4a" };

function ClipView({ clip, track, pxPerSec, height, selected, onSelect, onMoveClip, onTrimClip, onCommit }) {
  const dragState = useRef(null);

  function onMouseDownBody(e) {
    e.stopPropagation();
    onSelect(clip.id);
    dragState.current = { mode: "move", startX: e.clientX, origStart: clip.start };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }
  function onMouseDownHandle(e, edge) {
    e.stopPropagation();
    onSelect(clip.id);
    dragState.current = { mode: "trim", edge, startX: e.clientX, origStart: clip.start, origDuration: clip.duration };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }
  function onMouseMove(e) {
    const ds = dragState.current;
    if (!ds) return;
    const dx = (e.clientX - ds.startX) / pxPerSec;
    if (ds.mode === "move") {
      onMoveClip(clip.id, Math.max(0, ds.origStart + dx));
    } else if (ds.edge === "start") {
      onTrimClip(clip.id, "start", Math.max(0, ds.origStart + dx));
    } else {
      onTrimClip(clip.id, "end", ds.origStart + ds.origDuration + dx);
    }
  }
  function onMouseUp() {
    dragState.current = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    onCommit();
  }

  const label = clip.text || clip.captionText || clip.elementShape || track.name;
  return html`
    <div
      class="absolute top-1 bottom-1 rounded-md overflow-hidden select-none cursor-grab ${selected ? "ring-2 ring-violet-400" : "ring-1 ring-black/40"}"
      style="left:${clip.start * pxPerSec}px; width:${Math.max(4, clip.duration * pxPerSec)}px; background:${TRACK_COLOR[track.type] || "#333"}"
      onMouseDown=${onMouseDownBody}>
      <div class="px-1.5 py-0.5 text-[10px] text-white/90 truncate">${label}</div>
      <div class="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/10 hover:bg-white/30" onMouseDown=${(e) => onMouseDownHandle(e, "start")}></div>
      <div class="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/10 hover:bg-white/30" onMouseDown=${(e) => onMouseDownHandle(e, "end")}></div>
    </div>
  `;
}

// =============================================================================
// Properties panel (right side, context-sensitive)
// =============================================================================
function PropertiesPanel({ selected, project, onChange, onCommit }) {
  if (!selected) {
    return html`
      <div class="w-80 shrink-0 border-l border-neutral-800 p-4 bg-neutral-950">
        <h3 class="text-sm text-neutral-400 mb-1">Properties</h3>
        <p class="text-xs text-neutral-600">Select a clip on the timeline to edit its properties.</p>
        <${ProjectSettingsPanel} project=${project} />
      </div>
    `;
  }
  const { clip, track } = selected;
  const num = (v) => (v === undefined || v === null ? 0 : v);

  function field(prop, patch) {
    return (e) => onChange({ [prop]: patch ? patch(e) : parseFloat(e.target.value) });
  }

  return html`
    <div class="w-80 shrink-0 border-l border-neutral-800 p-4 bg-neutral-950 overflow-y-auto">
      <h3 class="text-sm text-neutral-200 mb-3">${track.type === "text" ? "Text" : track.type === "caption" ? "Caption" : track.type === "elements" ? "Element" : "Clip"}</h3>

      ${track.type === "text" && html`
        <${TextProperties} clip=${clip} onChange=${onChange} onCommit=${onCommit} />
      `}

      ${(track.type === "video" || track.type === "audio") && html`
        <${ClipTransformProperties} clip=${clip} onChange=${onChange} onCommit=${onCommit} />
      `}

      ${track.type === "elements" && html`
        <${ElementProperties} clip=${clip} onChange=${onChange} onCommit=${onCommit} />
      `}

      <div class="mt-4 pt-3 border-t border-neutral-800">
        <h4 class="text-xs uppercase tracking-wide text-neutral-500 mb-2">Timing</h4>
        <label class="prop-row"><span>Start</span><input type="number" step="0.1" class="prop-input" value=${clip.start.toFixed(2)} onChange=${field("start")} onBlur=${onCommit} /></label>
        <label class="prop-row"><span>Duration</span><input type="number" step="0.1" class="prop-input" value=${clip.duration.toFixed(2)} onChange=${field("duration")} onBlur=${onCommit} /></label>
        ${(track.type === "video" || track.type === "audio") && html`
          <label class="prop-row"><span>Speed</span>
            <select class="prop-input" value=${clip.speed} onChange=${(e) => { onChange({ speed: +e.target.value }); onCommit(); }}>
              ${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((s) => html`<option value=${s}>${s}x</option>`)}
            </select>
          </label>
        `}
      </div>
    </div>
  `;
}

function ProjectSettingsPanel({ project }) {
  return html`
    <div class="mt-6 pt-4 border-t border-neutral-800">
      <h4 class="text-xs uppercase tracking-wide text-neutral-500 mb-2">Project settings</h4>
      <label class="prop-row"><span>Width</span><input type="number" class="prop-input" value=${project.settings.width}
        onChange=${(e) => store.update((p) => ({ ...p, settings: { ...p.settings, width: +e.target.value } }))} /></label>
      <label class="prop-row"><span>Height</span><input type="number" class="prop-input" value=${project.settings.height}
        onChange=${(e) => store.update((p) => ({ ...p, settings: { ...p.settings, height: +e.target.value } }))} /></label>
      <label class="prop-row"><span>FPS</span>
        <select class="prop-input" value=${project.settings.fps} onChange=${(e) => store.update((p) => ({ ...p, settings: { ...p.settings, fps: +e.target.value } }))}>
          ${[24, 25, 30, 50, 60].map((f) => html`<option value=${f}>${f}</option>`)}
        </select>
      </label>
      <label class="prop-row"><span>Background</span><input type="color" class="prop-input h-7 p-0" value=${project.settings.backgroundColor}
        onChange=${(e) => store.update((p) => ({ ...p, settings: { ...p.settings, backgroundColor: e.target.value } }))} /></label>
    </div>
  `;
}

function ClipTransformProperties({ clip, onChange, onCommit }) {
  return html`
    <div class="space-y-3">
      <h4 class="text-xs uppercase tracking-wide text-neutral-500">Transform</h4>
      <${Slider} label="Position X" min="0" max="1" step="0.01" value=${clip.x} onChange=${(v) => onChange({ x: v })} onCommit=${onCommit} />
      <${Slider} label="Position Y" min="0" max="1" step="0.01" value=${clip.y} onChange=${(v) => onChange({ y: v })} onCommit=${onCommit} />
      <${Slider} label="Scale" min="0.1" max="3" step="0.01" value=${clip.scale} onChange=${(v) => onChange({ scale: v })} onCommit=${onCommit} />
      <${Slider} label="Rotation" min="-180" max="180" step="1" value=${clip.rotation} onChange=${(v) => onChange({ rotation: v })} onCommit=${onCommit} />
      <${Slider} label="Opacity" min="0" max="1" step="0.01" value=${clip.opacity} onChange=${(v) => onChange({ opacity: v })} onCommit=${onCommit} />

      <h4 class="text-xs uppercase tracking-wide text-neutral-500 pt-2">Audio</h4>
      <${Slider} label="Volume" min="0" max="2" step="0.01" value=${clip.volume} onChange=${(v) => onChange({ volume: v })} onCommit=${onCommit} />
      <${Slider} label="Fade in (s)" min="0" max="3" step="0.05" value=${clip.fadeIn} onChange=${(v) => onChange({ fadeIn: v })} onCommit=${onCommit} />
      <${Slider} label="Fade out (s)" min="0" max="3" step="0.05" value=${clip.fadeOut} onChange=${(v) => onChange({ fadeOut: v })} onCommit=${onCommit} />
      <label class="prop-row"><span>Mute</span><input type="checkbox" checked=${clip.muted} onChange=${(e) => { onChange({ muted: e.target.checked }); onCommit(); }} /></label>

      <h4 class="text-xs uppercase tracking-wide text-neutral-500 pt-2">Filter</h4>
      <div class="grid grid-cols-3 gap-1">
        ${Object.keys(FILTER_PRESETS).map((key) => html`
          <button class="text-[10px] rounded px-1 py-1.5 border ${clip.filter === key ? "border-violet-500 text-violet-300" : "border-neutral-800 text-neutral-400"}"
            onClick=${() => { onChange({ filter: key }); onCommit(); }}>${key}</button>
        `)}
      </div>

      <h4 class="text-xs uppercase tracking-wide text-neutral-500 pt-2">Adjustments</h4>
      <${Slider} label="Brightness" min="20" max="200" step="1" value=${clip.adjustments.brightness} onChange=${(v) => onChange({ adjustments: { ...clip.adjustments, brightness: v } })} onCommit=${onCommit} />
      <${Slider} label="Contrast" min="20" max="200" step="1" value=${clip.adjustments.contrast} onChange=${(v) => onChange({ adjustments: { ...clip.adjustments, contrast: v } })} onCommit=${onCommit} />
      <${Slider} label="Saturation" min="0" max="200" step="1" value=${clip.adjustments.saturation} onChange=${(v) => onChange({ adjustments: { ...clip.adjustments, saturation: v } })} onCommit=${onCommit} />
      <${Slider} label="Blur (px)" min="0" max="20" step="0.5" value=${clip.adjustments.blur} onChange=${(v) => onChange({ adjustments: { ...clip.adjustments, blur: v } })} onCommit=${onCommit} />

      <${KeyframePanel} clip=${clip} onChange=${onChange} onCommit=${onCommit} />
    </div>
  `;
}

function TextProperties({ clip, onChange, onCommit }) {
  const style = clip.textStyle;
  function setStyle(patch) {
    onChange({ textStyle: { ...style, ...patch } });
  }
  return html`
    <div class="space-y-3">
      <textarea class="w-full h-16 bg-neutral-900 border border-neutral-800 rounded p-2 text-xs" value=${clip.text}
        onChange=${(e) => onChange({ text: e.target.value })} onBlur=${onCommit} />
      <label class="prop-row"><span>Font</span>
        <select class="prop-input" value=${style.font} onChange=${(e) => { setStyle({ font: e.target.value }); onCommit(); }}>
          ${FONTS.map((f) => html`<option value=${f}>${f}</option>`)}
        </select>
      </label>
      <${Slider} label="Size" min="10" max="200" step="1" value=${style.size} onChange=${(v) => setStyle({ size: v })} onCommit=${onCommit} />
      <div class="flex gap-2">
        <button class="prop-toggle ${style.bold && "active"}" onClick=${() => { setStyle({ bold: !style.bold }); onCommit(); }}>B</button>
        <button class="prop-toggle ${style.italic && "active"}" onClick=${() => { setStyle({ italic: !style.italic }); onCommit(); }}>I</button>
        <select class="prop-input flex-1" value=${style.align} onChange=${(e) => { setStyle({ align: e.target.value }); onCommit(); }}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </select>
      </div>
      <label class="prop-row"><span>Color</span><input type="color" class="prop-input h-7 p-0" value=${style.color} onChange=${(e) => { setStyle({ color: e.target.value }); onCommit(); }} /></label>
      <label class="prop-row"><span>Stroke</span><input type="checkbox" checked=${!!style.stroke} onChange=${(e) => { setStyle({ stroke: e.target.checked }); onCommit(); }} /></label>
      <label class="prop-row"><span>Shadow</span><input type="checkbox" checked=${!!style.shadow} onChange=${(e) => { setStyle({ shadow: e.target.checked }); onCommit(); }} /></label>
      <label class="prop-row"><span>Background</span><input type="checkbox" checked=${!!style.bg} onChange=${(e) => { setStyle({ bg: e.target.checked ? "#000000" : null }); onCommit(); }} /></label>
      <${Slider} label="Letter/line spacing" min="0.8" max="2.5" step="0.05" value=${style.lineSpacing} onChange=${(v) => setStyle({ lineSpacing: v })} onCommit=${onCommit} />

      <h4 class="text-xs uppercase tracking-wide text-neutral-500 pt-2">Transform</h4>
      <${Slider} label="Position X" min="0" max="1" step="0.01" value=${clip.x} onChange=${(v) => onChange({ x: v })} onCommit=${onCommit} />
      <${Slider} label="Position Y" min="0" max="1" step="0.01" value=${clip.y} onChange=${(v) => onChange({ y: v })} onCommit=${onCommit} />
      <${Slider} label="Scale" min="0.1" max="4" step="0.01" value=${clip.scale} onChange=${(v) => onChange({ scale: v })} onCommit=${onCommit} />
      <${Slider} label="Rotation" min="-180" max="180" step="1" value=${clip.rotation} onChange=${(v) => onChange({ rotation: v })} onCommit=${onCommit} />
      <${Slider} label="Opacity" min="0" max="1" step="0.01" value=${clip.opacity} onChange=${(v) => onChange({ opacity: v })} onCommit=${onCommit} />

      <${KeyframePanel} clip=${clip} onChange=${onChange} onCommit=${onCommit} />
    </div>
  `;
}

function ElementProperties({ clip, onChange, onCommit }) {
  return html`
    <div class="space-y-3">
      <label class="prop-row"><span>Color</span><input type="color" class="prop-input h-7 p-0" value=${clip.elementColor} onChange=${(e) => { onChange({ elementColor: e.target.value }); onCommit(); }} /></label>
      <${Slider} label="Position X" min="0" max="1" step="0.01" value=${clip.x} onChange=${(v) => onChange({ x: v })} onCommit=${onCommit} />
      <${Slider} label="Position Y" min="0" max="1" step="0.01" value=${clip.y} onChange=${(v) => onChange({ y: v })} onCommit=${onCommit} />
      <${Slider} label="Scale" min="0.1" max="5" step="0.01" value=${clip.scale} onChange=${(v) => onChange({ scale: v })} onCommit=${onCommit} />
      <${Slider} label="Rotation" min="-180" max="180" step="1" value=${clip.rotation} onChange=${(v) => onChange({ rotation: v })} onCommit=${onCommit} />
      <${Slider} label="Opacity" min="0" max="1" step="0.01" value=${clip.opacity} onChange=${(v) => onChange({ opacity: v })} onCommit=${onCommit} />
      <${KeyframePanel} clip=${clip} onChange=${onChange} onCommit=${onCommit} />
    </div>
  `;
}

function KeyframePanel({ clip, onChange, onCommit }) {
  const [prop, setProp] = useState("scale");
  const playhead = store.get().playhead;
  const localT = Math.max(0, playhead - clip.start);
  const kfs = (clip.keyframes && clip.keyframes[prop]) || [];

  function addKeyframe() {
    const value = clip[prop];
    const next = [...kfs.filter((k) => Math.abs(k.t - localT) > 0.05), { t: localT, value, ease: "linear" }];
    onChange({ keyframes: { ...clip.keyframes, [prop]: next } });
    onCommit();
  }
  function removeKeyframe(t) {
    onChange({ keyframes: { ...clip.keyframes, [prop]: kfs.filter((k) => k.t !== t) } });
    onCommit();
  }

  return html`
    <div class="pt-2 border-t border-neutral-800 mt-2">
      <h4 class="text-xs uppercase tracking-wide text-neutral-500 mb-2">Keyframes</h4>
      <div class="flex gap-2 mb-2">
        <select class="prop-input flex-1" value=${prop} onChange=${(e) => setProp(e.target.value)}>
          ${["x", "y", "scale", "rotation", "opacity", "volume"].map((p) => html`<option value=${p}>${p}</option>`)}
        </select>
        <button class="btn-secondary text-xs px-2" onClick=${addKeyframe}>+ Add at playhead</button>
      </div>
      ${kfs.length === 0
        ? html`<p class="text-[10px] text-neutral-600">No keyframes on "${prop}" yet. Move the playhead and click Add.</p>`
        : html`<div class="space-y-1">
            ${[...kfs].sort((a, b) => a.t - b.t).map((k) => html`
              <div class="flex items-center justify-between text-[10px] bg-neutral-900 rounded px-2 py-1">
                <span>${fmtTime(k.t)} → ${typeof k.value === "number" ? k.value.toFixed(2) : k.value}</span>
                <button class="text-neutral-500 hover:text-red-400" onClick=${() => removeKeyframe(k.t)}>✕</button>
              </div>
            `)}
          </div>`}
    </div>
  `;
}

function Slider({ label, min, max, step, value, onChange, onCommit }) {
  return html`
    <label class="block">
      <div class="flex justify-between text-[11px] text-neutral-400 mb-0.5"><span>${label}</span><span>${Number(value).toFixed(2)}</span></div>
      <input type="range" min=${min} max=${max} step=${step} value=${value} class="w-full accent-violet-500"
        onInput=${(e) => onChange(+e.target.value)} onMouseUp=${onCommit} onTouchEnd=${onCommit} />
    </label>
  `;
}

// =============================================================================
// Export dialog
// =============================================================================
function ExportDialog({ project, onClose }) {
  const [resolution, setResolution] = useState("1080p");
  const [fps, setFps] = useState(project.settings.fps);
  const [quality, setQuality] = useState("high");
  const [format, setFormat] = useState("auto");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [resultName, setResultName] = useState(null);
  const [errMsg, setErrMsg] = useState(null);
  const signalRef = useRef({});

  const estMB = useMemo(() => {
    const dur = totalDuration(project);
    const mbps = { "480p": 2, "720p": 5, "1080p": 8, "1440p": 16, "2160p": 35 }[resolution] || 8;
    const mult = { low: 0.4, medium: 0.7, high: 1, veryHigh: 1.6 }[quality] || 1;
    return ((mbps * mult * dur) / 8).toFixed(0);
  }, [project, resolution, quality]);

  async function runExport() {
    setStage("Preparing media");
    setErrMsg(null);
    try {
      const { blob, mimeType, cancelled } = await exportProject(
        project,
        project.mediaLibrary,
        { resolution, fps, quality, format },
        {
          onProgress: (p) => setProgress(p),
          onStage: setStage,
          signal: signalRef.current,
        }
      );
      if (cancelled) {
        setStage(null);
        return;
      }
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setResultName(`${project.name.replace(/\s+/g, "_")}.${extensionForMime(mimeType)}`);
      setStage("Done");
    } catch (e) {
      setErrMsg(e.message || String(e));
      setStage(null);
    }
  }

  function cancelExport() {
    signalRef.current.oncancel?.();
  }

  return html`
    <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div class="bg-neutral-900 border border-neutral-800 rounded-lg w-[420px] p-5">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-sm font-medium text-neutral-100">Export video</h2>
          <button class="text-neutral-500" onClick=${onClose}>✕</button>
        </div>

        ${!stage && html`
          <div class="space-y-3">
            <label class="prop-row"><span>Resolution</span>
              <select class="prop-input" value=${resolution} onChange=${(e) => setResolution(e.target.value)}>
                ${["480p", "720p", "1080p", "1440p", "2160p"].map((r) => html`<option value=${r}>${r === "2160p" ? "2160p (4K)" : r}</option>`)}
              </select>
            </label>
            <label class="prop-row"><span>Frame rate</span>
              <select class="prop-input" value=${fps} onChange=${(e) => setFps(+e.target.value)}>
                ${[24, 25, 30, 50, 60].map((f) => html`<option value=${f}>${f} fps</option>`)}
              </select>
            </label>
            <label class="prop-row"><span>Quality</span>
              <select class="prop-input" value=${quality} onChange=${(e) => setQuality(e.target.value)}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="veryHigh">Very High</option>
              </select>
            </label>
            <p class="text-[11px] text-neutral-500">Estimated size: ~${estMB} MB · Format: WebM (VP9/H.264 auto-selected based on your browser)</p>
            <button class="btn-primary w-full" onClick=${runExport}>Start Export</button>
          </div>
        `}

        ${stage && stage !== "Done" && html`
          <div class="space-y-3">
            <p class="text-xs text-neutral-400">${stage}…</p>
            <div class="w-full h-2 bg-neutral-800 rounded overflow-hidden">
              <div class="h-full bg-violet-500" style="width:${Math.round(progress * 100)}%"></div>
            </div>
            <p class="text-[11px] text-neutral-500">${Math.round(progress * 100)}%</p>
            <button class="btn-secondary w-full" onClick=${cancelExport}>Cancel</button>
          </div>
        `}

        ${stage === "Done" && resultUrl && html`
          <div class="space-y-3">
            <p class="text-xs text-emerald-400">Export complete.</p>
            <a class="btn-primary w-full text-center block" href=${resultUrl} download=${resultName}>Download ${resultName}</a>
            <video src=${resultUrl} controls class="w-full rounded mt-2"></video>
          </div>
        `}

        ${errMsg && html`<p class="text-xs text-red-400 mt-3">${errMsg}</p>`}
      </div>
    </div>
  `;
}
