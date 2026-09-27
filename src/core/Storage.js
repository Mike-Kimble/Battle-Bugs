/**
 * Thin, failure-tolerant wrapper around localStorage.
 * Private windows / blocked storage degrade to an in-memory store.
 */
const memory = new Map();

function backend() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = '__bb_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

export const Storage = {
  load(key) {
    try {
      const ls = backend();
      const raw = ls ? ls.getItem(key) : memory.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('[Storage] load failed', err);
      return null;
    }
  },

  save(key, data) {
    try {
      const raw = JSON.stringify(data);
      const ls = backend();
      if (ls) ls.setItem(key, raw);
      else memory.set(key, raw);
      return true;
    } catch (err) {
      console.warn('[Storage] save failed', err);
      return false;
    }
  },

  clear(key) {
    try {
      const ls = backend();
      if (ls) ls.removeItem(key);
      memory.delete(key);
    } catch {
      memory.delete(key);
    }
  },
};
