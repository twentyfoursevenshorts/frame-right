// db.js — IndexedDB persistence layer.
// Two object stores: "projects" (JSON project documents) and "media" (raw Blobs, keyed by mediaId).
// Media files are stored separately from the project document so we never duplicate large
// video/audio data when a project is saved repeatedly (section 24 of the spec).

const DB_NAME = "framewright";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("media")) {
        db.createObjectStore("media", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  async saveProject(project) {
    return tx("projects", "readwrite", (store) => {
      store.put({ ...project, updatedAt: Date.now() });
    });
  },

  async loadProject(id) {
    const db_ = await openDB();
    return new Promise((resolve, reject) => {
      const t = db_.transaction("projects", "readonly");
      const req = t.objectStore("projects").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async listProjects() {
    const db_ = await openDB();
    return new Promise((resolve, reject) => {
      const t = db_.transaction("projects", "readonly");
      const req = t.objectStore("projects").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteProject(id) {
    return tx("projects", "readwrite", (store) => store.delete(id));
  },

  async saveMedia(id, blob, meta) {
    return tx("media", "readwrite", (store) => {
      store.put({ id, blob, meta });
    });
  },

  async loadMedia(id) {
    const db_ = await openDB();
    return new Promise((resolve, reject) => {
      const t = db_.transaction("media", "readonly");
      const req = t.objectStore("media").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteMedia(id) {
    return tx("media", "readwrite", (store) => store.delete(id));
  },
};
