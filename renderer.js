// renderer.js — the single rendering function used by BOTH the live preview and the
// export pipeline (section 37: "separate the editing representation from the final
// render"). This guarantees the exported file matches what you saw in preview.

const FILTER_PRESETS = {
  none: "",
  cinematic: "contrast(1.08) saturate(0.9) brightness(0.97) sepia(0.08)",
  warm: "sepia(0.25) saturate(1.2) brightness(1.03)",
  cool: "hue-rotate(-8deg) saturate(1.1) brightness(1.02)",
  vintage: "sepia(0.35) contrast(0.9) saturate(0.75) brightness(1.05)",
  bw: "grayscale(1) contrast(1.1)",
  highContrast: "contrast(1.4) saturate(1.15)",
  faded: "contrast(0.85) saturate(0.7) brightness(1.08)",
  vibrant: "saturate(1.5) contrast(1.08)",
};

function activeClipsAt(track, t) {
  return track.clips.filter((c) => t >= c.start && t < c.start + c.duration);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function ease(x, type) {
  switch (type) {
    case "easeIn":
      return x * x;
    case "easeOut":
      return 1 - (1 - x) * (1 - x);
    case "easeInOut":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    default:
      return x; // linear
  }
}

// Resolves an animated property: uses keyframes if present, else the static clip value.
function resolveProp(clip, prop, localTime) {
  const kfs = clip.keyframes && clip.keyframes[prop];
  if (!kfs || kfs.length === 0) return clip[prop];
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  if (localTime <= sorted[0].t) return sorted[0].value;
  if (localTime >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (localTime >= a.t && localTime <= b.t) {
      const span = b.t - a.t || 1e-6;
      const x = ease((localTime - a.t) / span, b.ease || "linear");
      return lerp(a.value, b.value, x);
    }
  }
  return clip[prop];
}

function computeOpacityWithFades(clip, localTime) {
  let op = resolveProp(clip, "opacity", localTime);
  if (clip.fadeIn && localTime < clip.fadeIn) op *= localTime / clip.fadeIn;
  if (clip.fadeOut && localTime > clip.duration - clip.fadeOut) {
    op *= Math.max(0, (clip.duration - localTime) / clip.fadeOut);
  }
  return op;
}

function drawTextClip(ctx, clip, W, H, localTime) {
  const style = clip.textStyle || {};
  const x = resolveProp(clip, "x", localTime) * W;
  const y = resolveProp(clip, "y", localTime) * H;
  const scale = resolveProp(clip, "scale", localTime);
  const rotation = resolveProp(clip, "rotation", localTime);
  const opacity = computeOpacityWithFades(clip, localTime);

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.translate(x, y);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(scale, scale);

  const size = style.size || 48;
  const weight = style.bold ? "700" : "400";
  const styleItalic = style.italic ? "italic" : "normal";
  ctx.font = `${styleItalic} ${weight} ${size}px ${style.font || "Inter"}, sans-serif`;
  ctx.textAlign = style.align || "center";
  ctx.textBaseline = "middle";

  const lines = String(clip.text || "").split("\n");
  const lineHeight = size * (style.lineSpacing || 1.2);
  const totalH = lineHeight * lines.length;

  lines.forEach((line, i) => {
    const ly = i * lineHeight - totalH / 2 + lineHeight / 2;
    if (style.bg) {
      const w = ctx.measureText(line).width + size * 0.6;
      ctx.save();
      ctx.globalAlpha *= style.bgOpacity ?? 1;
      ctx.fillStyle = style.bg;
      const bx = style.align === "left" ? 0 : style.align === "right" ? -w : -w / 2;
      roundRect(ctx, bx, ly - lineHeight / 2, w, lineHeight, 8);
      ctx.fill();
      ctx.restore();
    }
    if (style.shadow) {
      ctx.shadowColor = style.shadowColor || "rgba(0,0,0,0.6)";
      ctx.shadowBlur = style.shadowBlur ?? 6;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
    }
    if (style.stroke) {
      ctx.lineWidth = style.strokeWidth || 4;
      ctx.strokeStyle = style.strokeColor || "#000000";
      ctx.strokeText(line, 0, ly);
    }
    ctx.fillStyle = style.color || "#ffffff";
    ctx.fillText(line, 0, ly);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCaptionClip(ctx, clip, W, H, style) {
  const text = clip.captionText || "";
  if (!text) return;
  const size = style.size || 42;
  ctx.save();
  ctx.font = `700 ${size}px ${style.font || "Inter"}, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxWidth = W * 0.82;
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  words.forEach((w) => {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  });
  if (cur) lines.push(cur);

  const lineHeight = size * 1.25;
  const posY = style.position === "top" ? H * 0.12 : style.position === "middle" ? H * 0.5 : H * 0.86;
  const totalH = lineHeight * lines.length;

  lines.forEach((line, i) => {
    const ly = posY - totalH / 2 + i * lineHeight + lineHeight / 2;
    const w = ctx.measureText(line).width + 28;
    ctx.save();
    ctx.globalAlpha = style.bgOpacity ?? 0.55;
    ctx.fillStyle = style.bg || "#000000";
    roundRect(ctx, W / 2 - w / 2, ly - lineHeight / 2 + 4, w, lineHeight - 8, 10);
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = style.strokeWidth ?? 2;
    ctx.strokeStyle = style.stroke || "#000000";
    if (ctx.lineWidth > 0) ctx.strokeText(line, W / 2, ly);
    ctx.fillStyle = style.color || "#ffffff";
    ctx.fillText(line, W / 2, ly);
  });
  ctx.restore();
}

function drawElementClip(ctx, clip, W, H, localTime) {
  const x = resolveProp(clip, "x", localTime) * W;
  const y = resolveProp(clip, "y", localTime) * H;
  const scale = resolveProp(clip, "scale", localTime);
  const rotation = resolveProp(clip, "rotation", localTime);
  const opacity = computeOpacityWithFades(clip, localTime);
  const s = clip.elementShape || "rect";
  const size = 120 * scale;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.translate(x, y);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.fillStyle = clip.elementColor || "#7c5cff";
  ctx.strokeStyle = clip.elementColor || "#7c5cff";
  ctx.lineWidth = 6;

  if (s === "rect") ctx.fillRect(-size / 2, -size / 2, size, size);
  else if (s === "circle") {
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (s === "line") {
    ctx.beginPath();
    ctx.moveTo(-size / 2, 0);
    ctx.lineTo(size / 2, 0);
    ctx.stroke();
  } else if (s === "arrow") {
    ctx.beginPath();
    ctx.moveTo(-size / 2, 0);
    ctx.lineTo(size / 2, 0);
    ctx.lineTo(size / 2 - 20, -20);
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2 - 20, 20);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Renders one composited frame.
 * @param ctx CanvasRenderingContext2D
 * @param project the project object
 * @param t current time in seconds
 * @param mediaEls Map<mediaId, HTMLVideoElement|HTMLImageElement> — pre-seeked elements ready to draw
 */
export function renderFrame(ctx, project, t, mediaEls) {
  const { width: W, height: H, backgroundColor } = project.settings;
  ctx.save();
  ctx.fillStyle = backgroundColor || "#000000";
  ctx.fillRect(0, 0, W, H);

  const videoTracks = project.tracks.filter((tr) => tr.type === "video" && !tr.hidden);
  const textTracks = project.tracks.filter((tr) => tr.type === "text" && !tr.hidden);
  const captionTracks = project.tracks.filter((tr) => tr.type === "caption" && !tr.hidden);

  // Video/image tracks, bottom-to-top (later tracks composite on top)
  videoTracks.forEach((track) => {
    activeClipsAt(track, t).forEach((clip) => {
      const el = mediaEls.get(clip.mediaId);
      if (!el) return;
      const localTime = t - clip.start;
      const opacity = computeOpacityWithFades(clip, localTime);
      const x = resolveProp(clip, "x", localTime) * W;
      const y = resolveProp(clip, "y", localTime) * H;
      const scale = resolveProp(clip, "scale", localTime);
      const rotation = resolveProp(clip, "rotation", localTime);

      const srcW = el.videoWidth || el.naturalWidth || W;
      const srcH = el.videoHeight || el.naturalHeight || H;
      const fit = Math.max(W / srcW, H / srcH); // cover-fit into canvas
      const drawW = srcW * fit * scale;
      const drawH = srcH * fit * scale;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
      const filterStr = [FILTER_PRESETS[clip.filter] || "", adjustmentsToFilter(clip.adjustments)]
        .filter(Boolean)
        .join(" ");
      if (filterStr) ctx.filter = filterStr;
      ctx.translate(x, y);
      ctx.rotate((rotation * Math.PI) / 180);
      try {
        ctx.drawImage(el, -drawW / 2, -drawH / 2, drawW, drawH);
      } catch (e) {
        /* element not ready this frame — skip, next frame will catch up */
      }
      ctx.restore();
    });
  });

  textTracks.forEach((track) => {
    activeClipsAt(track, t).forEach((clip) => drawTextClip(ctx, clip, W, H, t - clip.start));
  });

  project.tracks
    .filter((tr) => tr.type === "elements" && !tr.hidden)
    .forEach((track) => activeClipsAt(track, t).forEach((clip) => drawElementClip(ctx, clip, W, H, t - clip.start)));

  captionTracks.forEach((track) => {
    activeClipsAt(track, t).forEach((clip) => drawCaptionClip(ctx, clip, W, H, project.captionStyle));
  });

  ctx.restore();
}

function adjustmentsToFilter(adj) {
  if (!adj) return "";
  const parts = [];
  if (adj.brightness !== 100) parts.push(`brightness(${adj.brightness / 100})`);
  if (adj.contrast !== 100) parts.push(`contrast(${adj.contrast / 100})`);
  if (adj.saturation !== 100) parts.push(`saturate(${adj.saturation / 100})`);
  if (adj.blur) parts.push(`blur(${adj.blur}px)`);
  return parts.join(" ");
}

export function totalDuration(project) {
  let max = 0;
  project.tracks.forEach((tr) => tr.clips.forEach((c) => (max = Math.max(max, c.start + c.duration))));
  return max;
}

export { FILTER_PRESETS, resolveProp, computeOpacityWithFades };
