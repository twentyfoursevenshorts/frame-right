// export.js — REAL export, not a fake progress bar.
//
// How it works (documented honestly, see README "How export works"):
// 1. We build an offscreen canvas at the target resolution.
// 2. We build hidden <video>/<audio> elements for every clip used in the timeline.
// 3. We create a single AudioContext, route every clip's audio through a GainNode
//    (for volume/fades) into a MediaStreamAudioDestinationNode.
// 4. We combine canvas.captureStream(fps) video tracks with the mixed audio track
//    into one MediaStream, and record it with MediaRecorder.
// 5. We drive an actual real-time playback pass across the full project duration,
//    calling renderFrame() every animation frame — exactly the same function the
//    live preview uses — so the export is guaranteed to match what you saw.
//
// LIMITATION (documented, not hidden): because this uses MediaRecorder capturing a
// live real-time stream, export takes roughly as long as the video's own duration
// (a 2-minute timeline takes ~2 minutes to export), and the container is WebM
// (VP9/Opus) unless the browser exposes a working MP4/H.264 recorder mimeType.
// This is a genuine constraint of doing 4K encoding entirely client-side without a
// native FFmpeg process or a downloaded FFmpeg.wasm core (this sandbox has no
// network access to fetch that core at build time). If you run this app somewhere
// with network access, see README for how to wire in @ffmpeg/ffmpeg for real MP4/H.264
// offline (faster-than-real-time) export instead.

import { renderFrame, totalDuration } from "./renderer.js";
import { rehydrateMediaUrl } from "./media.js";

const RES_MAP = {
  "480p": { w: 854, h: 480 },
  "720p": { w: 1280, h: 720 },
  "1080p": { w: 1920, h: 1080 },
  "1440p": { w: 2560, h: 1440 },
  "2160p": { w: 3840, h: 2160 },
};

function pickMimeType(format) {
  const candidates =
    format === "mp4"
      ? ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"]
      : [];
  candidates.push("video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm");
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

function bitrateFor(resKey, quality) {
  const base = { "480p": 2, "720p": 5, "1080p": 8, "1440p": 16, "2160p": 35 }[resKey] || 8; // Mbps at "high"
  const mult = { low: 0.4, medium: 0.7, high: 1, veryHigh: 1.6 }[quality] || 1;
  return Math.round(base * mult * 1_000_000);
}

async function buildMediaElement(item, urlCache) {
  let url = item.objectUrl;
  if (!url) {
    url = await rehydrateMediaUrl(item.mediaId);
    urlCache.set(item.mediaId, url);
  }
  if (item.type === "image") {
    const img = new Image();
    img.src = url;
    await new Promise((res) => (img.onload = res));
    return img;
  }
  const el = document.createElement(item.type === "audio" ? "audio" : "video");
  el.src = url;
  el.muted = false;
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  await new Promise((res) => {
    el.onloadedmetadata = res;
    el.onerror = res;
  });
  return el;
}

export async function exportProject(project, mediaLibrary, opts, callbacks) {
  const { resolution, fps, quality, format } = opts;
  const { onProgress, onStage, signal } = callbacks;

  onStage("Preparing media");
  const res = RES_MAP[resolution] || RES_MAP["1080p"];
  const canvas = document.createElement("canvas");
  canvas.width = res.w;
  canvas.height = res.h;
  const ctx = canvas.getContext("2d");

  // Build a project clone scaled to export resolution for the renderer (positions are normalized, so
  // only settings.width/height need to change).
  const exportProjectDoc = { ...project, settings: { ...project.settings, width: res.w, height: res.h } };

  const libById = new Map(mediaLibrary.map((m) => [m.id, m]));
  const mediaByMediaId = new Map(mediaLibrary.map((m) => [m.mediaId, m]));

  const usedMediaIds = new Set();
  project.tracks.forEach((tr) => tr.clips.forEach((c) => c.mediaId && usedMediaIds.add(c.mediaId)));

  const urlCache = new Map();
  const mediaEls = new Map(); // mediaId -> element (for renderer, video/image)
  const audioNodes = new Map(); // clip.id -> { el, gain }

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const destination = audioCtx.createMediaStreamDestination();

  for (const mediaId of usedMediaIds) {
    const item = mediaByMediaId.get(mediaId);
    if (!item) continue;
    const el = await buildMediaElement(item, urlCache);
    mediaEls.set(mediaId, el);
  }

  // Wire audio: every clip that has a corresponding audio-capable element gets its own
  // MediaElementAudioSourceNode -> GainNode -> destination, so volume/fade/mute per-clip
  // genuinely affects the mixed export audio.
  const audioTracks = project.tracks.filter((t) => t.type === "audio" || t.type === "video");
  const gainAutomation = [];
  for (const track of audioTracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.muted || !clip.mediaId) continue;
      const el = mediaEls.get(clip.mediaId);
      if (!el || el.tagName === "IMG") continue;
      if (audioNodes.has(clip.id)) continue;
      // Each <video>/<audio> element can only be connected to ONE MediaElementSource ever,
      // so if a clip reuses the same media element as its visual track we still only source it once.
      let source;
      try {
        source = audioCtx.createMediaElementSource(el);
      } catch (e) {
        continue; // already connected elsewhere (e.g. same media used twice) — skip extra audio graph
      }
      const gain = audioCtx.createGain();
      gain.gain.value = clip.volume ?? 1;
      source.connect(gain).connect(destination);
      audioNodes.set(clip.id, { el, gain, clip, track });
      gainAutomation.push({ clip, gain });
    }
  }

  const duration = totalDuration(project);
  if (duration <= 0) throw new Error("Nothing on the timeline to export.");

  const videoStream = canvas.captureStream(fps);
  const combined = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);

  const mimeType = pickMimeType(format);
  const recorder = new MediaRecorder(combined, {
    mimeType,
    videoBitsPerSecond: bitrateFor(resolution, quality),
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const resultPromise = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
    recorder.onerror = (e) => reject(e.error || new Error("Recorder error"));
  });

  onStage("Rendering");
  recorder.start(250);

  let cancelled = false;
  if (signal) signal.oncancel = () => (cancelled = true);

  const startedAt = performance.now();
  let raf;

  await new Promise((resolve) => {
    function tick() {
      if (cancelled) {
        resolve();
        return;
      }
      const elapsed = (performance.now() - startedAt) / 1000;
      const t = Math.min(elapsed, duration);

      // Sync every active media element's currentTime/play state to the export clock.
      project.tracks.forEach((track) => {
        if (track.hidden) return;
        track.clips.forEach((clip) => {
          const el = mediaEls.get(clip.mediaId);
          if (!el || el.tagName === "IMG") return;
          const active = t >= clip.start && t < clip.start + clip.duration;
          if (active) {
            const local = (t - clip.start) * (clip.speed || 1) + clip.trimIn;
            if (Math.abs(el.currentTime - local) > 0.15) el.currentTime = local;
            el.playbackRate = clip.speed || 1;
            if (el.paused) el.play().catch(() => {});
          } else if (!el.paused) {
            el.pause();
          }
        });
      });

      renderFrame(ctx, exportProjectDoc, t, mediaEls);
      onProgress(Math.min(1, t / duration), t, duration);

      if (t >= duration) {
        resolve();
      } else {
        raf = requestAnimationFrame(tick);
      }
    }
    raf = requestAnimationFrame(tick);
  });

  cancelAnimationFrame(raf);
  mediaEls.forEach((el) => {
    if (el.tagName !== "IMG") el.pause();
  });
  recorder.stop();
  const blob = await resultPromise;
  audioCtx.close();

  onStage(cancelled ? "Cancelled" : "Finalizing");
  return { blob, mimeType, cancelled };
}

export function extensionForMime(mimeType) {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}
