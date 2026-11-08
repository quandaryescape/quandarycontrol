/**
 * What player screens may see about a room.
 *
 * Saved hint presets and GM notes often contain solutions and lock codes, so
 * they are stripped from every endpoint that player screens, themes or
 * hardware use (the legacy /api and /api/v1 read routes).
 */
const DEFAULT_HINTS_CLEARED = 'Hints have been cleared';
const DEFAULT_CHAT_CLEARED = 'Chat cleared';

function safeJson(str, fallback) {
  if (str === null || str === undefined || str === '') return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

/** Player-facing wording for hints & chat (immersion settings). */
function hintDisplay(hintConfig = {}) {
  const text = (v, fallback, max) => (typeof v === 'string' ? v.slice(0, max) : fallback);
  const name = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : fallback);
  return {
    type: hintConfig.type === 'chat' ? 'chat' : 'broadcast',
    // An empty string is allowed and means "show nothing"
    clearedMessage: text(hintConfig.clearedMessage, DEFAULT_HINTS_CLEARED, 200),
    chatClearedMessage: text(hintConfig.chatClearedMessage, DEFAULT_CHAT_CLEARED, 200),
    gmName: name(hintConfig.gmName, 'GM'),
    playerName: name(hintConfig.playerName, 'Player')
  };
}

/** Hint config as returned to players: no presets, display defaults filled in. */
function publicHints(hintConfig) {
  const hc = safeJson(hintConfig, {}) || {};
  const { presets, ...rest } = hc;
  return { ...rest, ...hintDisplay(hc) };
}

/** A raw rooms row with GM-only fields removed. */
function publicRoomRow(row) {
  if (!row) return row;
  const config = safeJson(row.config, {}) || {};
  delete config.gmNotes;
  const hc = safeJson(row.hint_config, {}) || {};
  delete hc.presets;
  return { ...row, config: JSON.stringify(config), hint_config: JSON.stringify(hc) };
}

module.exports = { hintDisplay, publicHints, publicRoomRow, DEFAULT_HINTS_CLEARED, DEFAULT_CHAT_CLEARED };
