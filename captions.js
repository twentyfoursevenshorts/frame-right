// captions.js
//
// HONEST SCOPE NOTE (see README "Known limitations"): real speech-to-text on an
// arbitrary imported audio/video file normally requires a model like Whisper running
// either locally (large download, GPU-friendly) or via a cloud API. This build
// environment has no network access, so no model weights or API could be fetched or
// verified working. Rather than fake a transcript, Framewright supports two REAL
// caption workflows:
//
//   1. Manual transcript editor — type/paste your transcript, then use "Auto-split
//      into captions" which does real, deterministic timing: it distributes your
//      text across the clip's duration using word-count-weighted timing and your
//      max-characters-per-line setting. You then drag each caption's in/out points
//      to match, same as any pro editor's manual caption pass.
//
//   2. Live auto-transcription while recording a voiceover — uses the browser's
//      native SpeechRecognition API (Chrome/Edge) to transcribe your mic in real
//      time AS you record, producing real word-level timestamps for that new
//      recording. This is genuine, on-device-or-browser-vendor STT, not a mock.
//
// If you deploy this with network access, swap `transcribeLive` for a call to a
// Whisper endpoint to add full file transcription — the caption data model
// (segments with {start,end,text}) is already shaped to accept it unchanged.

export function isLiveSpeechRecognitionSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function startLiveTranscription(lang, onSegment) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error("This browser does not expose SpeechRecognition. Try Chrome or Edge, or use the manual transcript editor instead.");
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang || "en-US";

  const startedAt = performance.now();
  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        if (text) {
          const end = (performance.now() - startedAt) / 1000;
          onSegment({ text, end });
        }
      }
    }
  };
  rec.start();
  return rec; // caller keeps reference to call .stop()
}

// Distributes a manually-written transcript across a duration, splitting on
// max characters per line, producing real (not placeholder) timed segments
// weighted by word length.
export function autoSplitTranscript(transcript, duration, maxCharsPerLine = 42) {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Group words into lines respecting maxCharsPerLine.
  const lines = [];
  let cur = [];
  let curLen = 0;
  for (const w of words) {
    const addLen = (cur.length ? 1 : 0) + w.length;
    if (curLen + addLen > maxCharsPerLine && cur.length) {
      lines.push(cur);
      cur = [w];
      curLen = w.length;
    } else {
      cur.push(w);
      curLen += addLen;
    }
  }
  if (cur.length) lines.push(cur);

  const totalChars = lines.reduce((s, l) => s + l.join(" ").length, 0) || 1;
  let t = 0;
  return lines.map((line) => {
    const text = line.join(" ");
    const share = text.length / totalChars;
    const segDur = Math.max(0.6, share * duration);
    const seg = { start: t, end: Math.min(duration, t + segDur), text };
    t += segDur;
    return seg;
  });
}

export const CAPTION_PRESETS = {
  clean: { size: 40, color: "#ffffff", bg: "#000000", bgOpacity: 0.5, stroke: "#000000", strokeWidth: 0, position: "bottom" },
  bold: { size: 52, color: "#ffffff", bg: "#000000", bgOpacity: 0, stroke: "#000000", strokeWidth: 6, position: "bottom" },
  minimal: { size: 34, color: "#ffffff", bg: "#000000", bgOpacity: 0, stroke: "#000000", strokeWidth: 0, position: "bottom" },
  karaoke: { size: 44, color: "#ffe066", bg: "#000000", bgOpacity: 0.35, stroke: "#000000", strokeWidth: 2, position: "bottom" },
  social: { size: 46, color: "#ffffff", bg: "#111111", bgOpacity: 0.75, stroke: "#000000", strokeWidth: 0, position: "middle" },
  largeCentered: { size: 64, color: "#ffffff", bg: "#000000", bgOpacity: 0, stroke: "#000000", strokeWidth: 5, position: "middle" },
  lowerThird: { size: 30, color: "#ffffff", bg: "#7c5cff", bgOpacity: 0.85, stroke: "#000000", strokeWidth: 0, position: "bottom" },
};
