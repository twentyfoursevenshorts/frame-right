// store.js — the single source of truth for the project.
// A tiny pub/sub store (no external state library needed) that:
//  - holds the project data model (section 36 of the spec)
//  - exposes mutation helpers
//  - keeps a history stack for undo/redo (section 22)
//  - is fully JSON-serializable so it can be persisted verbatim (section 24)

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function newProject(name = "Untitled Project") {
  return {
    id: uid("proj"),
    name,
    createdAt: Date.now(),
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      backgroundColor: "#000000",
      aspectPreset: "16:9",
    },
    exportSettings: {
      resolution: "1080p",
      fps: 30,
      quality: "high",
      format: "auto",
    },
    mediaLibrary: [], // { id, name, type, duration, width, height, size, mediaId }
    tracks: [
      { id: uid("track"), type: "video", name: "Video 1", clips: [], muted: false, locked: false, hidden: false },
      { id: uid("track"), type: "audio", name: "Audio 1", clips: [], muted: false, locked: false, hidden: false },
      { id: uid("track"), type: "text", name: "Text", clips: [], muted: false, locked: false, hidden: false },
      { id: uid("track"), type: "caption", name: "Captions", clips: [], muted: false, locked: false, hidden: false },
    ],
    captionStyle: {
      font: "Inter",
      size: 42,
      color: "#ffffff",
      bg: "#000000",
      bgOpacity: 0.55,
      stroke: "#000000",
      strokeWidth: 2,
      position: "bottom",
      preset: "clean",
    },
  };
}

export function newClip(overrides = {}) {
  return {
    id: uid("clip"),
    mediaId: null,
    start: 0, // position on timeline, seconds
    duration: 5,
    trimIn: 0, // in-point within source media, seconds
    trimOut: 5, // out-point within source media, seconds
    speed: 1,
    // transform
    x: 0.5, // normalized 0-1 center position
    y: 0.5,
    scale: 1,
    rotation: 0,
    opacity: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
    filter: "none", // preset id
    adjustments: { brightness: 100, contrast: 100, saturation: 100, blur: 0 },
    transitionIn: null, // { type, duration }
    keyframes: {}, // { propName: [{t, value, ease}] }
    // text-specific
    text: null,
    textStyle: null,
    // caption-specific
    captionText: null,
    ...overrides,
  };
}

class Store {
  constructor() {
    this.state = { project: newProject(), selection: null, playhead: 0, isPlaying: false, zoom: 60 };
    this.listeners = new Set();
    this.past = [];
    this.future = [];
    this.HISTORY_LIMIT = 100;
  }

  get() {
    return this.state;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.listeners.forEach((fn) => fn(this.state));
  }

  // Mutates project state via `updater(project) -> project` and snapshots history.
  update(updater, { pushHistory = true } = {}) {
    if (pushHistory) {
      this.past.push(JSON.stringify(this.state.project));
      if (this.past.length > this.HISTORY_LIMIT) this.past.shift();
      this.future = [];
    }
    const next = updater(structuredClone(this.state.project));
    this.state = { ...this.state, project: next };
    this.emit();
  }

  // Non-history UI-only updates (selection, playhead, zoom, isPlaying)
  setUI(partial) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  undo() {
    if (!this.past.length) return;
    this.future.push(JSON.stringify(this.state.project));
    const prev = JSON.parse(this.past.pop());
    this.state = { ...this.state, project: prev };
    this.emit();
  }

  redo() {
    if (!this.future.length) return;
    this.past.push(JSON.stringify(this.state.project));
    const next = JSON.parse(this.future.pop());
    this.state = { ...this.state, project: next };
    this.emit();
  }

  loadProject(project) {
    this.state = { ...this.state, project, playhead: 0, selection: null };
    this.past = [];
    this.future = [];
    this.emit();
  }
}

export const store = new Store();
export { uid };
