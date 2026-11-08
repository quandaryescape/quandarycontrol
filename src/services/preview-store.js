/**
 * Short-lived in-memory store for unsaved theme drafts shown in the builder's
 * live preview iframe.
 */
const { nanoid } = require('nanoid');

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;
const drafts = new Map();

function sweep() {
  const now = Date.now();
  for (const [token, entry] of drafts) {
    if (entry.expires < now) drafts.delete(token);
  }
  while (drafts.size > MAX_ENTRIES) {
    drafts.delete(drafts.keys().next().value);
  }
}

function put(draft, token) {
  sweep();
  const key = token && drafts.has(token) ? token : nanoid(16);
  drafts.set(key, { ...draft, expires: Date.now() + TTL_MS });
  return key;
}

function get(token) {
  const entry = drafts.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    drafts.delete(token);
    return null;
  }
  entry.expires = Date.now() + TTL_MS;
  return entry;
}

module.exports = { put, get };
