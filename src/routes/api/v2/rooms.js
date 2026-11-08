const express = require('express');
const { nanoid } = require('nanoid');
const { getDatabase } = require('../../../../db/database');
const { parseVariables, TIMER_VARIABLE_NAMES } = require('../../../services/variable-service');
const themeService = require('../../../services/theme-service');
const { asyncRoute, httpError, ok, safeJson, requireRoom, services } = require('./helpers');

const router = express.Router();

const SHORTCODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

function generateShortcode(db) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const length = 4 + Math.floor(attempt / 500);
    let code = '';
    for (let i = 0; i < length; i++) code += SHORTCODE_CHARS[Math.floor(Math.random() * SHORTCODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM rooms WHERE shortcode = ?').get(code)) return code;
  }
  throw new Error('Unable to generate unique shortcode');
}

/** Accept a room id or its short code (hardware URLs are easier to type with codes). */
function resolveRoom(idOrCode) {
  const db = getDatabase();
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(idOrCode)
    || db.prepare('SELECT * FROM rooms WHERE shortcode = ?').get(String(idOrCode || '').toUpperCase());
  if (!room) throw httpError(404, 'Room not found');
  return room;
}

function clampSeconds(v, max = 24 * 3600) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function cleanPresets(presets) {
  if (!Array.isArray(presets)) return [];
  return presets
    .filter(p => p && String(p.text || '').trim())
    .slice(0, 200)
    .map(p => ({
      id: p.id || nanoid(8),
      text: String(p.text).trim().slice(0, 1000),
      category: String(p.category || '').trim().slice(0, 60)
    }));
}

const HEX = /^#[0-9a-fA-F]{6}$/;
// Room icons must be files uploaded to this server (no external or script URLs)
const ICON_URL = /^\/(uploads|themes\/[A-Za-z0-9_-]+\/assets)\/[\w.%-]+\.(png|jpe?g|gif|webp|svg|avif)$/i;
const TIMER_FONTS = new Set(['inter', 'oswald', 'orbitron', 'bebas', 'rajdhani', 'jetbrains', 'system']);

function cleanAppearance(input = {}, current = {}) {
  const out = { ...current };
  if (input.accent !== undefined) out.accent = HEX.test(input.accent || '') ? input.accent.toLowerCase() : null;
  if (input.background !== undefined) out.background = HEX.test(input.background || '') ? input.background.toLowerCase() : null;
  if (input.timerFont !== undefined) out.timerFont = TIMER_FONTS.has(input.timerFont) ? input.timerFont : 'inter';
  if (input.icon !== undefined) {
    if (input.icon && !ICON_URL.test(input.icon)) throw httpError(400, 'Room icon must be an image uploaded to Quandary Control');
    out.icon = input.icon || null;
  }
  return out;
}

function toRoomDTO(row, { includeVariables = true } = {}) {
  const db = getDatabase();
  const config = safeJson(row.config, {});
  const hintConfig = safeJson(row.hint_config, {});
  const dto = {
    id: row.id,
    name: row.name,
    shortcode: row.shortcode,
    created_at: row.created_at,
    theme: config.theme || 'boilerplate',
    description: config.description || '',
    gmNotes: config.gmNotes || '',
    appearance: {
      accent: (config.appearance && config.appearance.accent) || null,
      background: (config.appearance && config.appearance.background) || null,
      timerFont: (config.appearance && config.appearance.timerFont) || 'inter',
      icon: (config.appearance && config.appearance.icon) || null
    },
    timer: {
      duration: row.timer_duration || 0,
      secondaryEnabled: !!row.secondary_timer_enabled,
      secondaryDuration: row.secondary_timer_duration || 0,
      secondaryLabel: config.secondaryTimerLabel || 'Secondary timer'
    },
    hints: {
      type: hintConfig.type === 'chat' ? 'chat' : 'broadcast',
      presets: cleanPresets(hintConfig.presets),
      limit: Number(hintConfig.limit) || 0
    },
    stats: {
      slideshows: db.prepare('SELECT COUNT(*) AS n FROM slideshows WHERE room_id = ?').get(row.id).n,
      automations: db.prepare('SELECT COUNT(*) AS n FROM automations WHERE room_id = ?').get(row.id).n
    }
  };
  if (includeVariables) dto.variables = parseVariables(row.api_variables);
  return dto;
}

/**
 * Merge a structured update into the room row.
 */
function applyRoomUpdate(db, room, body) {
  const config = safeJson(room.config, {});
  const hintConfig = safeJson(room.hint_config, {});
  const sets = [];
  const vals = [];

  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (name.length < 1 || name.length > 100) throw httpError(400, 'Room name must be 1–100 characters');
    sets.push('name = ?'); vals.push(name);
  }
  if (body.theme !== undefined) {
    if (!themeService.isValidSlug(body.theme) || !themeService.exists(body.theme)) throw httpError(400, `Theme "${body.theme}" not found`);
    config.theme = body.theme;
  }
  if (body.description !== undefined) config.description = String(body.description || '').slice(0, 2000);
  if (body.gmNotes !== undefined) config.gmNotes = String(body.gmNotes || '').slice(0, 50000);
  if (body.appearance && typeof body.appearance === 'object') config.appearance = cleanAppearance(body.appearance, config.appearance || {});

  if (body.timer && typeof body.timer === 'object') {
    const t = body.timer;
    if (t.duration !== undefined) { sets.push('timer_duration = ?'); vals.push(clampSeconds(t.duration)); }
    if (t.secondaryEnabled !== undefined) { sets.push('secondary_timer_enabled = ?'); vals.push(t.secondaryEnabled ? 1 : 0); }
    if (t.secondaryDuration !== undefined) { sets.push('secondary_timer_duration = ?'); vals.push(clampSeconds(t.secondaryDuration)); }
    if (t.secondaryLabel !== undefined) config.secondaryTimerLabel = String(t.secondaryLabel || '').slice(0, 60);
  }

  if (body.hints && typeof body.hints === 'object') {
    if (body.hints.type !== undefined) hintConfig.type = body.hints.type === 'chat' ? 'chat' : 'broadcast';
    if (body.hints.presets !== undefined) hintConfig.presets = cleanPresets(body.hints.presets);
    if (body.hints.limit !== undefined) hintConfig.limit = Math.max(0, Math.min(99, parseInt(body.hints.limit, 10) || 0));
  }

  sets.push('config = ?'); vals.push(JSON.stringify(config));
  sets.push('hint_config = ?'); vals.push(JSON.stringify(hintConfig));
  vals.push(room.id);
  db.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/* ------------------------------------------------------------------ rooms */

router.get('/rooms', asyncRoute(async (req, res) => {
  const { timerService } = services();
  const rows = getDatabase().prepare('SELECT * FROM rooms ORDER BY created_at DESC').all();
  ok(res, rows.map(r => ({
    ...toRoomDTO(r, { includeVariables: false }),
    live: { timer: timerService.getTimerState(r.id, 'main') }
  })));
}));

router.post('/rooms', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'Room name is required');
  const theme = body.theme && themeService.exists(body.theme) ? body.theme : 'boilerplate';

  const id = nanoid();
  db.prepare(`
    INSERT INTO rooms (id, shortcode, name, config, timer_duration, secondary_timer_enabled, secondary_timer_duration, api_variables, hint_config)
    VALUES (?, ?, ?, ?, ?, 0, 0, '{}', ?)
  `).run(id, generateShortcode(db), name.slice(0, 100), JSON.stringify({ theme }), 3600, JSON.stringify({ type: 'broadcast', presets: [] }));

  const room = requireRoom(id);
  applyRoomUpdate(db, room, { ...body, name, theme });
  ok(res, toRoomDTO(requireRoom(id)), 201);
}));

router.get('/rooms/:id', asyncRoute(async (req, res) => {
  ok(res, toRoomDTO(requireRoom(req.params.id)));
}));

/** Player-safe subset (no GM notes) */
router.get('/rooms/:id/public', asyncRoute(async (req, res) => {
  const room = resolveRoom(req.params.id);
  const dto = toRoomDTO(room, { includeVariables: false });
  ok(res, { id: dto.id, name: dto.name, shortcode: dto.shortcode, theme: dto.theme, hints: { type: dto.hints.type }, slideshows: dto.stats.slideshows, appearance: { accent: dto.appearance.accent, icon: dto.appearance.icon } });
}));

router.put('/rooms/:id', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const room = requireRoom(req.params.id);
  applyRoomUpdate(db, room, req.body || {});
  const updated = requireRoom(room.id);

  // Keep idle in-memory timers in step with the new configuration
  const { timerService, io } = services();
  if (updated.timer_duration > 0) timerService.syncDuration(room.id, updated.timer_duration, 'main', io);
  if (updated.secondary_timer_enabled) {
    timerService.initializeTimer(room.id, updated.secondary_timer_duration || 300, 'secondary');
    timerService.syncDuration(room.id, updated.secondary_timer_duration || 300, 'secondary', io);
    timerService.setEnabled(room.id, true, 'secondary', io);
  } else if (timerService.getTimerState(room.id, 'secondary')) {
    timerService.setEnabled(room.id, false, 'secondary', io);
  }

  const dto = toRoomDTO(updated);
  io.to(room.id).emit('room_updated', { id: dto.id, name: dto.name, theme: dto.theme, hints: { type: dto.hints.type }, timer: dto.timer, appearance: dto.appearance });
  ok(res, dto);
}));

router.delete('/rooms/:id', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  const { timerService, automationEngine } = services();
  getDatabase().prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  timerService.clearRoomTimers(room.id);
  automationEngine.invalidate(room.id);
  ok(res, { id: room.id });
}));

router.post('/rooms/:id/shortcode', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const room = requireRoom(req.params.id);
  db.prepare('UPDATE rooms SET shortcode = ? WHERE id = ?').run(generateShortcode(db), room.id);
  ok(res, toRoomDTO(requireRoom(room.id)));
}));

/**
 * Duplicate a room with its slideshows and automations (great for running
 * the same game in two rooms).
 */
router.post('/rooms/:id/duplicate', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const src = requireRoom(req.params.id);
  const newId = nanoid();
  const name = String((req.body && req.body.name) || `${src.name} (copy)`).slice(0, 100);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO rooms (id, shortcode, name, config, timer_duration, secondary_timer_enabled, secondary_timer_duration, api_variables, custom_html, custom_css, rules_config, hint_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newId, generateShortcode(db), name, src.config, src.timer_duration, src.secondary_timer_enabled, src.secondary_timer_duration,
      src.api_variables, src.custom_html || '', src.custom_css || '', src.rules_config || '{}', src.hint_config);

    const shows = db.prepare('SELECT * FROM slideshows WHERE room_id = ?').all(src.id);
    for (const show of shows) {
      const showId = nanoid(12);
      db.prepare('INSERT INTO slideshows (id, room_id, name, description, settings, order_index) VALUES (?, ?, ?, ?, ?, ?)')
        .run(showId, newId, show.name, show.description, show.settings, show.order_index);
      for (const slide of db.prepare('SELECT * FROM slides WHERE slideshow_id = ?').all(show.id)) {
        db.prepare('INSERT INTO slides (id, slideshow_id, type, media_url, title, body, settings, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(12), showId, slide.type, slide.media_url, slide.title, slide.body, slide.settings, slide.order_index);
      }
    }

    for (const a of db.prepare('SELECT * FROM automations WHERE room_id = ?').all(src.id)) {
      db.prepare(`INSERT INTO automations (id, room_id, name, enabled, trigger_config, conditions, actions, cooldown_seconds, order_index, hook_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nanoid(12), newId, a.name, a.enabled, a.trigger_config, a.conditions, a.actions, a.cooldown_seconds, a.order_index, a.hook_key ? nanoid(16) : null);
    }
  })();

  ok(res, toRoomDTO(requireRoom(newId)), 201);
}));

/* -------------------------------------------------------------- variables */

router.get('/rooms/:id/variables', asyncRoute(async (req, res) => {
  const room = resolveRoom(req.params.id);
  const { variableService } = services();
  ok(res, { user: variableService.getUserVariables(room.id), timers: variableService.getTimerVariables(room.id) });
}));

router.put('/rooms/:id/variables', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  const vars = req.body && req.body.variables;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw httpError(400, 'variables must be an object');
  ok(res, services().variableService.replaceVariables(room.id, vars));
}));

router.put('/rooms/:id/variables/:name', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  const { value, type = 'auto' } = req.body || {};
  if (value === undefined) throw httpError(400, 'value is required');
  ok(res, services().variableService.setVariable(room.id, req.params.name, value, { type, source: 'admin' }));
}));

router.delete('/rooms/:id/variables/:name', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  ok(res, { deleted: services().variableService.deleteVariable(room.id, req.params.name) });
}));

/**
 * Hardware-friendly: works with a simple GET from an Arduino/ESP32/Shelly/etc.
 *   /api/v2/rooms/ABCD/variables/door/set?value=open
 *   /api/v2/rooms/ABCD/variables/score/increment?by=5
 *   /api/v2/rooms/ABCD/variables/lights/toggle
 */
const VARIABLE_OPS = new Set(['set', 'increment', 'decrement', 'toggle']);
router.all('/rooms/:id/variables/:name/:op', asyncRoute(async (req, res, next) => {
  if (!VARIABLE_OPS.has(req.params.op)) return next();
  if (!['GET', 'POST', 'PUT'].includes(req.method)) throw httpError(405, 'Use GET or POST');
  const room = resolveRoom(req.params.id);
  const { variableService } = services();
  const body = req.body || {};
  const source = `http:${req.ip}`;
  let result;
  if (req.params.op === 'set') {
    const value = body.value !== undefined ? body.value : req.query.value;
    if (value === undefined) throw httpError(400, 'Pass ?value=… or a JSON body {"value": …}');
    result = variableService.setVariable(room.id, req.params.name, value, { type: body.type || req.query.type || 'auto', source });
  } else {
    const amount = body.by !== undefined ? body.by : (req.query.by !== undefined ? req.query.by : 1);
    result = variableService.modifyVariable(room.id, req.params.name, req.params.op, amount, { source });
  }
  ok(res, { room: room.shortcode, name: result.name, value: result.value, previous: result.previous });
}));

/* ------------------------------------------------------------ timer & hints */

const TIMER_COMMANDS = new Set(['start', 'pause', 'stop', 'reset', 'add', 'subtract', 'toggle']);
router.all('/rooms/:id/timer/:command', asyncRoute(async (req, res, next) => {
  if (!TIMER_COMMANDS.has(req.params.command)) return next();
  if (!['GET', 'POST'].includes(req.method)) throw httpError(405, 'Use GET or POST');
  const room = resolveRoom(req.params.id);
  const { timerService, io } = services();
  const type = (req.query.timer || (req.body && req.body.timer)) === 'secondary' ? 'secondary' : 'main';
  const seconds = clampSeconds((req.body && req.body.seconds) ?? req.query.seconds ?? 60);

  const configured = type === 'main' ? room.timer_duration : room.secondary_timer_duration;
  timerService.initializeTimer(room.id, configured > 0 ? configured : 300, type);

  let done;
  switch (req.params.command) {
    case 'start': done = timerService.startTimer(room.id, type, io); break;
    case 'pause': done = timerService.pauseTimer(room.id, type, io); break;
    case 'stop': done = timerService.stopTimer(room.id, type, io); break;
    case 'reset': done = timerService.resetTimer(room.id, configured, type, io); break;
    case 'add': done = timerService.adjustTimer(room.id, seconds, type, io); break;
    case 'subtract': done = timerService.adjustTimer(room.id, -seconds, type, io); break;
    case 'toggle': {
      const st = timerService.getTimerState(room.id, type);
      done = st && st.running ? timerService.pauseTimer(room.id, type, io) : timerService.startTimer(room.id, type, io);
      break;
    }
  }
  ok(res, { changed: !!done, timer: type, state: timerService.getTimerState(room.id, type) });
}));

router.post('/rooms/:id/hint', asyncRoute(async (req, res) => {
  const room = resolveRoom(req.params.id);
  const message = String((req.body && req.body.message) || req.query.message || '').trim();
  if (!message) throw httpError(400, 'message is required');
  const { io, automationEngine } = services();
  const hint = { message: message.slice(0, 1000), timestamp: new Date().toISOString(), source: 'api' };
  io.to(room.id).emit('hintReceived', hint);
  automationEngine.onRoomEvent(room.id, 'hint_sent', { message: hint.message }).catch(() => {});
  ok(res, hint);
}));

module.exports = router;
module.exports.toRoomDTO = toRoomDTO;
module.exports.resolveRoom = resolveRoom;
module.exports.TIMER_VARIABLE_NAMES = TIMER_VARIABLE_NAMES;
