const { getDatabase } = require('../../db/database');

function get(key, fallback = null) {
  const row = getDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function set(key, value) {
  if (value === null || value === undefined || value === '') {
    getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  getDatabase().prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

function maskKey(key) {
  if (!key) return '';
  const k = String(key);
  if (k.length <= 10) return '•'.repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

module.exports = { get, set, maskKey };
