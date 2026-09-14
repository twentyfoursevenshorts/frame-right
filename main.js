import { App } from "./app.js";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));

// Warn users up front if their browser lacks the APIs Framewright depends on,
// instead of failing silently mid-edit.
window.addEventListener("DOMContentLoaded", () => {
  const missing = [];
  if (!window.indexedDB) missing.push("IndexedDB (project saving)");
  if (!HTMLCanvasElement.prototype.captureStream) missing.push("Canvas.captureStream (export)");
  if (!window.MediaRecorder) missing.push("MediaRecorder (export)");
  if (missing.length) {
    console.warn("Framewright: this browser is missing required APIs:", missing.join(", "), "— use a recent Chrome, Edge, or Firefox.");
  }
});
