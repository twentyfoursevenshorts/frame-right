// media.js — turns a dropped/selected File into a MediaLibrary entry with real
// probed metadata (duration/width/height), a real thumbnail, and (for audio/video)
// a real decoded waveform. Nothing here is placeholder data.

import { db } from "./db.js";
import { uid } from "./store.js";

const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/x-msvideo"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const AUDIO_TYPES = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp4", "audio/ogg", "audio/flac"];

function kindOf(file) {
  if (VIDEO_TYPES.includes(file.type) || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) return "video";
  if (IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name)) return "image";
  if (AUDIO_TYPES.includes(file.type) || /\.(mp3|wav|aac|m4a|ogg|flac)$/i.test(file.name)) return "audio";
  return null;
}

function probeVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = url;
    v.onloadedmetadata = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => reject(new Error("Could not read video metadata — the codec may be unsupported by this browser."));
  });
}

function probeAudio(url) {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.src = url;
    a.onloadedmetadata = () => resolve({ duration: a.duration });
    a.onerror = () => reject(new Error("Could not read audio metadata — the codec may be unsupported by this browser."));
  });
}

function probeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: 5 });
    img.onerror = () => reject(new Error("Could not read image."));
    img.src = url;
  });
}

async function makeVideoThumbnail(url, atSeconds = 0.3) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.src = url;
    v.currentTime = 0;
    v.onloadeddata = () => {
      v.currentTime = Math.min(atSeconds, (v.duration || 1) - 0.05);
    };
    v.onseeked = () => {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = Math.round((160 * (v.videoHeight || 9)) / (v.videoWidth || 16));
      const ctx = c.getContext("2d");
      ctx.drawImage(v, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.7));
    };
    v.onerror = () => resolve(null);
  });
}

async function decodeWaveform(file) {
  try {
    const arrayBuf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    const raw = audioBuf.getChannelData(0);
    const samples = 400;
    const blockSize = Math.max(1, Math.floor(raw.length / samples));
    const peaks = [];
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize; j++) sum += Math.abs(raw[start + j] || 0);
      peaks.push(sum / blockSize);
    }
    const max = Math.max(...peaks, 0.0001);
    ctx.close();
    return peaks.map((p) => p / max);
  } catch (e) {
    return null; // waveform is optional decoration; failure shouldn't block import
  }
}

export async function importFile(file) {
  const kind = kindOf(file);
  if (!kind) {
    throw new Error(`Unsupported file type: "${file.name}". Framewright supports MP4/WebM/MOV video, PNG/JPG/WebP/GIF images, and MP3/WAV/AAC/OGG/FLAC audio.`);
  }
  const objectUrl = URL.createObjectURL(file);
  let meta;
  try {
    if (kind === "video") meta = await probeVideo(objectUrl);
    else if (kind === "audio") meta = await probeAudio(objectUrl);
    else meta = await probeImage(objectUrl);
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    throw e;
  }

  const mediaId = uid("media");
  await db.saveMedia(mediaId, file, { name: file.name, type: kind, mime: file.type });

  let thumbnail = null;
  let waveform = null;
  if (kind === "video") thumbnail = await makeVideoThumbnail(objectUrl);
  if (kind === "image") thumbnail = objectUrl;
  if (kind === "audio" || kind === "video") waveform = await decodeWaveform(file);

  return {
    id: uid("libitem"),
    mediaId,
    name: file.name,
    type: kind,
    duration: meta.duration || 5,
    width: meta.width || null,
    height: meta.height || null,
    size: file.size,
    thumbnail,
    waveform,
    objectUrl, // kept live for this session; reconstructed from stored blob on reload
  };
}

export async function rehydrateMediaUrl(mediaId) {
  const rec = await db.loadMedia(mediaId);
  if (!rec) return null;
  return URL.createObjectURL(rec.blob);
}
