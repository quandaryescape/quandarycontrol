/**
 * Automation engine: WHEN <trigger> IF <conditions> THEN <actions>.
 *
 * Trigger types
 *   variable  { variable, operator, value }        edge-triggered on change
 *   timer     { timer, event, seconds }            remaining/elapsed crossings + start/pause/complete/reset
 *   webhook   {}                                   inbound URL /api/hooks/:hookKey
 *   manual    { label, color }                     GM button
 *   event     { event }                            player_connected | hint_sent | player_message | gm_message
 *
 * Action types
 *   show_message, show_media, play_sound, send_hint, set_variable, timer,
 *   http_request, delay, start_slideshow, room_command, run_automation
 */
const { nanoid } = require('nanoid');
const { getDatabase } = require('../../db/database');
const { logger } = require('../../utils/logger');
const { autoCoerce } = require('./variable-service');

const engineLogger = logger.child({ module: 'automation-engine' });

const MAX_DEPTH = 8;
const MAX_LOG = 100;
const MAX_DELAY_SECONDS = 3600;
const HTTP_TIMEOUT_MS = 10000;

const OPERATORS = {
  equals: (a, b) => looseEquals(a, b),
  not_equals: (a, b) => !looseEquals(a, b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
  not_contains: (a, b) => !String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
  is_true: (a) => isTruthy(a),
  is_false: (a) => !isTruthy(a),
  is_empty: (a) => a === undefined || a === null || a === '',
  is_not_empty: (a) => !(a === undefined || a === null || a === '')
};

function isTruthy(v) {
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
  return !!v;
}

function looseEquals(a, b) {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && a !== null && b !== null && !Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== 'boolean' && typeof b !== 'boolean') {
    return na === nb;
  }
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function compare(operator, actual, expected) {
  const fn = OPERATORS[operator];
  if (!fn) return false;
  try { return !!fn(actual, expected); } catch (_) { return false; }
}

function formatSeconds(total) {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

/**
 * Replace {{path}} tokens. Unknown short names fall back to variables.
 */
function renderTemplate(template, context) {
  if (typeof template !== 'string' || !template.includes('{{')) return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, path) => {
    let value = getPath(context, path);
    if (value === undefined && context.variables) value = getPath(context.variables, path);
    if (value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

function safeJson(str, fallback) {
  if (str === null || str === undefined || str === '') return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function rowToAutomation(row) {
  return {
    id: row.id,
    room_id: row.room_id,
    name: row.name,
    enabled: !!row.enabled,
    trigger: safeJson(row.trigger_config, { type: 'manual' }),
    conditions: safeJson(row.conditions, { mode: 'all', rules: [] }),
    actions: safeJson(row.actions, []),
    cooldown_seconds: row.cooldown_seconds || 0,
    order_index: row.order_index || 0,
    hook_key: row.hook_key || null,
    last_run_at: row.last_run_at || null,
    run_count: row.run_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

class AutomationEngine {
  constructor({ io, timerService, variableService }) {
    this.io = io;
    this.timerService = timerService;
    this.variableService = variableService;
    this.cache = new Map();      // roomId -> automations[]
    this.logs = new Map();       // roomId -> log entries (newest first)
    this.lastRun = new Map();    // automationId -> ms timestamp
    this.pending = new Set();    // delay timeouts so tests/shutdown can clear them
  }

  /* ---------------------------------------------------------------- data */

  invalidate(roomId) {
    if (roomId) this.cache.delete(roomId); else this.cache.clear();
  }

  list(roomId) {
    if (this.cache.has(roomId)) return this.cache.get(roomId);
    const rows = getDatabase()
      .prepare('SELECT * FROM automations WHERE room_id = ? ORDER BY order_index ASC, created_at ASC')
      .all(roomId)
      .map(rowToAutomation);
    this.cache.set(roomId, rows);
    return rows;
  }

  get(id) {
    const row = getDatabase().prepare('SELECT * FROM automations WHERE id = ?').get(id);
    return row ? rowToAutomation(row) : null;
  }

  getByHookKey(hookKey) {
    const row = getDatabase().prepare('SELECT * FROM automations WHERE hook_key = ?').get(hookKey);
    return row ? rowToAutomation(row) : null;
  }

  static normalize(input = {}) {
    const trigger = input.trigger && typeof input.trigger === 'object' ? input.trigger : { type: 'manual' };
    const conditions = input.conditions && typeof input.conditions === 'object'
      ? { mode: input.conditions.mode === 'any' ? 'any' : 'all', rules: Array.isArray(input.conditions.rules) ? input.conditions.rules : [] }
      : { mode: 'all', rules: [] };
    const actions = Array.isArray(input.actions) ? input.actions.filter(a => a && a.type) : [];
    return {
      name: String(input.name || 'Untitled automation').slice(0, 120),
      enabled: input.enabled === undefined ? true : !!input.enabled,
      trigger,
      conditions,
      actions,
      cooldown_seconds: Math.max(0, Math.min(86400, parseInt(input.cooldown_seconds, 10) || 0))
    };
  }

  create(roomId, input) {
    const db = getDatabase();
    const a = AutomationEngine.normalize(input);
    const id = nanoid(12);
    const hookKey = a.trigger.type === 'webhook' ? nanoid(16) : null;
    const max = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM automations WHERE room_id = ?').get(roomId).m;
    db.prepare(`
      INSERT INTO automations (id, room_id, name, enabled, trigger_config, conditions, actions, cooldown_seconds, order_index, hook_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, roomId, a.name, a.enabled ? 1 : 0, JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.actions), a.cooldown_seconds, max + 1, hookKey);
    this.invalidate(roomId);
    return this.get(id);
  }

  update(id, input) {
    const db = getDatabase();
    const existing = this.get(id);
    if (!existing) return null;
    const a = AutomationEngine.normalize({ ...existing, ...input });
    let hookKey = existing.hook_key;
    if (a.trigger.type === 'webhook' && !hookKey) hookKey = nanoid(16);
    db.prepare(`
      UPDATE automations SET name = ?, enabled = ?, trigger_config = ?, conditions = ?, actions = ?, cooldown_seconds = ?, hook_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(a.name, a.enabled ? 1 : 0, JSON.stringify(a.trigger), JSON.stringify(a.conditions), JSON.stringify(a.actions), a.cooldown_seconds, hookKey, id);
    this.invalidate(existing.room_id);
    return this.get(id);
  }

  regenerateHookKey(id) {
    const existing = this.get(id);
    if (!existing) return null;
    getDatabase().prepare('UPDATE automations SET hook_key = ? WHERE id = ?').run(nanoid(16), id);
    this.invalidate(existing.room_id);
    return this.get(id);
  }

  remove(id) {
    const existing = this.get(id);
    if (!existing) return false;
    getDatabase().prepare('DELETE FROM automations WHERE id = ?').run(id);
    this.invalidate(existing.room_id);
    return true;
  }

  reorder(roomId, ids) {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE automations SET order_index = ? WHERE id = ? AND room_id = ?');
    db.transaction(() => ids.forEach((id, idx) => stmt.run(idx, id, roomId)))();
    this.invalidate(roomId);
    return this.list(roomId);
  }

  /* ---------------------------------------------------------------- logs */

  log(roomId, entry) {
    const full = { id: nanoid(8), at: new Date().toISOString(), ...entry };
    const list = this.logs.get(roomId) || [];
    list.unshift(full);
    if (list.length > MAX_LOG) list.length = MAX_LOG;
    this.logs.set(roomId, list);
    if (this.io) {
      this.io.to(`admin_${roomId}`).emit('automation_log', full);
      this.io.to(`gm_${roomId}`).emit('automation_log', full);
    }
    return full;
  }

  getLogs(roomId) {
    return this.logs.get(roomId) || [];
  }

  /* ------------------------------------------------------------ matching */

  /**
   * Does this automation's trigger match the event?
   */
  matches(automation, event) {
    const t = automation.trigger || {};
    if (t.type !== event.type) return false;

    switch (t.type) {
      case 'variable': {
        if (t.variable !== event.name) return false;
        const op = t.operator || 'equals';
        if (op === 'any_change' || op === 'changes') return true;
        if (op === 'changes_from') return looseEquals(event.previous, t.value) && !looseEquals(event.value, t.value);
        // Edge-trigger: only fire when the condition becomes true (not on every update while true)
        const nowTrue = compare(op, event.value, t.value);
        const wasTrue = event.previous === undefined ? false : compare(op, event.previous, t.value);
        return nowTrue && !wasTrue;
      }
      case 'timer': {
        if ((t.timer || 'main') !== event.timer) return false;
        const want = t.event || 'remaining';
        if (want === 'remaining' || want === 'elapsed') {
          if (event.phase !== 'tick') return false;
          const target = Number(t.seconds) || 0;
          if (want === 'remaining') {
            return event.previous > target && event.remaining <= target;
          }
          const elapsedNow = event.duration - event.remaining;
          const elapsedPrev = event.duration - event.previous;
          return elapsedPrev < target && elapsedNow >= target;
        }
        return event.phase === want;
      }
      case 'webhook':
      case 'manual':
        return event.automationId === automation.id;
      case 'event':
        return t.event === event.event;
      default:
        return false;
    }
  }

  evaluateConditions(conditions, variables) {
    const rules = (conditions && Array.isArray(conditions.rules)) ? conditions.rules.filter(r => r && r.variable) : [];
    if (rules.length === 0) return true;
    const results = rules.map(r => compare(r.operator || 'equals', variables[r.variable], r.value));
    return conditions.mode === 'any' ? results.some(Boolean) : results.every(Boolean);
  }

  buildContext(roomId, event, extra = {}) {
    const db = getDatabase();
    const room = db.prepare('SELECT id, name, shortcode FROM rooms WHERE id = ?').get(roomId) || { id: roomId };
    const variables = (this.variableService && this.variableService.getAllVariables(roomId)) || {};
    const main = this.timerService ? this.timerService.getTimerState(roomId, 'main') : null;
    const secondary = this.timerService ? this.timerService.getTimerState(roomId, 'secondary') : null;
    const timerCtx = (s) => s ? {
      remaining: s.remaining,
      elapsed: s.duration - s.remaining,
      duration: s.duration,
      remaining_formatted: formatSeconds(s.remaining),
      elapsed_formatted: formatSeconds(s.duration - s.remaining),
      status: s.status
    } : {};
    return {
      room,
      variables,
      timer: timerCtx(main),
      secondary_timer: timerCtx(secondary),
      event: event || {},
      payload: (event && event.payload) || {},
      now: new Date().toISOString(),
      ...extra
    };
  }

  /* ----------------------------------------------------------- execution */

  /**
   * Entry point for all events.
   */
  async handleEvent(roomId, event, { depth = 0 } = {}) {
    if (depth > MAX_DEPTH) {
      this.log(roomId, { level: 'error', message: `Stopped: automations triggered each other more than ${MAX_DEPTH} levels deep (possible loop)` });
      return [];
    }
    let automations;
    try {
      automations = this.list(roomId).filter(a => a.enabled);
    } catch (err) {
      engineLogger.error('Failed to load automations', { roomId, error: err.message });
      return [];
    }
    if (automations.length === 0) return [];

    const matched = automations.filter(a => this.matches(a, event));
    const runs = [];
    for (const automation of matched) {
      runs.push(this.execute(roomId, automation, event, { depth }));
    }
    return Promise.all(runs);
  }

  /**
   * Run an automation's conditions + actions.
   * @param {object} opts.force  skip conditions/cooldown (used by "Test" buttons)
   */
  async execute(roomId, automation, event = {}, { depth = 0, force = false } = {}) {
    const now = Date.now();
    if (!force && automation.cooldown_seconds > 0) {
      const last = this.lastRun.get(automation.id) || 0;
      if (now - last < automation.cooldown_seconds * 1000) {
        this.log(roomId, { level: 'skip', automationId: automation.id, automation: automation.name, message: 'Skipped (cooldown)' });
        return { ran: false, reason: 'cooldown' };
      }
    }

    const context = this.buildContext(roomId, event);
    if (!force && !this.evaluateConditions(automation.conditions, context.variables)) {
      this.log(roomId, { level: 'skip', automationId: automation.id, automation: automation.name, message: 'Conditions not met' });
      return { ran: false, reason: 'conditions' };
    }

    this.lastRun.set(automation.id, now);
    try {
      getDatabase().prepare('UPDATE automations SET last_run_at = CURRENT_TIMESTAMP, run_count = run_count + 1 WHERE id = ?').run(automation.id);
      // Keep cached copy roughly in sync without a reload
      automation.run_count = (automation.run_count || 0) + 1;
      automation.last_run_at = new Date().toISOString();
    } catch (_) { /* row may be gone (test runs) */ }

    this.log(roomId, {
      level: 'run',
      automationId: automation.id,
      automation: automation.name,
      message: `Triggered by ${describeEvent(event)}${force ? ' (test)' : ''}`
    });

    const results = [];
    for (const action of automation.actions) {
      if (action.disabled) continue;
      try {
        const result = await this.runAction(roomId, action, context, { depth, automation });
        results.push({ type: action.type, ok: true, ...result });
      } catch (err) {
        results.push({ type: action.type, ok: false, error: err.message });
        this.log(roomId, { level: 'error', automationId: automation.id, automation: automation.name, message: `${action.type} failed: ${err.message}` });
      }
    }
    return { ran: true, results };
  }

  async runAction(roomId, action, context, { depth, automation }) {
    const io = this.io;
    const r = (s) => renderTemplate(s, context);

    switch (action.type) {
      case 'show_message': {
        const payload = {
          text: r(action.text || ''),
          title: r(action.title || ''),
          duration: Number(action.duration) || 0,
          style: action.style || 'info'
        };
        io && io.to(roomId).emit('show_message', payload);
        return { detail: payload.text };
      }

      case 'show_media': {
        const payload = {
          mediaId: action.mediaId || null,
          url: action.url || null,
          headline: r(action.headline || ''),
          autoCloseEnabled: Number(action.duration) > 0,
          autoCloseSeconds: Number(action.duration) || 0
        };
        io && io.to(roomId).emit('show_lightbox', payload);
        return { detail: payload.headline || payload.url || payload.mediaId };
      }

      case 'play_sound': {
        let url = action.url || '';
        if (url && !url.startsWith('/') && !/^https?:\/\//i.test(url)) {
          // Legacy actions stored a notification-audio id instead of a URL
          const row = getDatabase().prepare('SELECT file_path FROM notification_audio WHERE id = ?').get(url);
          if (row && row.file_path) url = row.file_path.startsWith('/') ? row.file_path : `/${row.file_path}`;
        }
        if (!url) throw new Error('No sound selected');
        const payload = { url, file: url, volume: Number(action.volume) || 70, target: action.target || 'players' };
        if (payload.target === 'gm') io && io.to(`gm_${roomId}`).emit('play_sound', payload);
        else if (payload.target === 'all') io && io.to(roomId).emit('play_sound', payload);
        else io && io.to(roomId).emit('play_sound', { ...payload, playerOnly: true });
        return { detail: payload.url };
      }

      case 'send_hint': {
        const message = r(action.message || '').slice(0, 1000);
        if (!message) throw new Error('Hint message is empty');
        const hint = { message, timestamp: new Date().toISOString(), source: 'automation' };
        io && io.to(roomId).emit('hintReceived', hint);
        return { detail: message };
      }

      case 'set_variable': {
        if (!action.variable) throw new Error('No variable selected');
        const mode = action.mode || 'set';
        const value = typeof action.value === 'string' ? autoCoerce(r(action.value)) : action.value;
        const res = mode === 'set'
          ? this.variableService.setVariable(roomId, action.variable, value, { type: 'auto', source: `automation:${automation.name}`, depth: depth + 1 })
          : this.variableService.modifyVariable(roomId, action.variable, mode, value, { source: `automation:${automation.name}`, depth: depth + 1 });
        return { detail: `${action.variable} = ${JSON.stringify(res.value)}` };
      }

      case 'timer': {
        const type = action.timer === 'secondary' ? 'secondary' : 'main';
        const seconds = Number(action.seconds) || 0;
        const ts = this.timerService;
        if (!ts.getTimerState(roomId, type)) {
          const room = getDatabase().prepare('SELECT timer_duration, secondary_timer_duration FROM rooms WHERE id = ?').get(roomId) || {};
          ts.initializeTimer(roomId, type === 'main' ? room.timer_duration : room.secondary_timer_duration, type);
        }
        let ok;
        switch (action.command) {
          case 'start': ok = ts.startTimer(roomId, type, io); break;
          case 'pause': ok = ts.pauseTimer(roomId, type, io); break;
          case 'stop': ok = ts.stopTimer(roomId, type, io); break;
          case 'reset': ok = ts.resetTimer(roomId, seconds || null, type, io); break;
          case 'add': ok = ts.adjustTimer(roomId, Math.abs(seconds), type, io); break;
          case 'subtract': ok = ts.adjustTimer(roomId, -Math.abs(seconds), type, io); break;
          default: throw new Error(`Unknown timer command "${action.command}"`);
        }
        return { detail: `${type} timer ${action.command}${seconds ? ` ${seconds}s` : ''}${ok ? '' : ' (no change)'}` };
      }

      case 'http_request': {
        const url = r(action.url || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
        const method = String(action.method || 'POST').toUpperCase();
        const headers = {};
        (Array.isArray(action.headers) ? action.headers : []).forEach(h => {
          if (h && h.key) headers[String(h.key)] = r(String(h.value ?? ''));
        });
        const init = { method, headers, signal: AbortSignal.timeout(Number(action.timeoutMs) || HTTP_TIMEOUT_MS) };
        if (!['GET', 'HEAD'].includes(method) && action.body) {
          init.body = r(action.body);
          if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = /^\s*[{[]/.test(init.body) ? 'application/json' : 'text/plain';
          }
        }
        const started = Date.now();
        const res = await fetch(url, init);
        const text = await res.text().catch(() => '');
        const detail = `${method} ${url} → ${res.status} (${Date.now() - started}ms)`;
        this.log(roomId, { level: res.ok ? 'info' : 'error', automationId: automation.id, automation: automation.name, message: detail, response: text.slice(0, 500) });
        if (action.saveResponseTo) {
          this.variableService.setVariable(roomId, action.saveResponseTo, text.slice(0, 2000), { type: 'auto', source: 'http_request', depth: depth + 1 });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { detail, status: res.status };
      }

      case 'delay': {
        const seconds = Math.max(0, Math.min(MAX_DELAY_SECONDS, Number(action.seconds) || 0));
        await new Promise(resolve => {
          const t = setTimeout(() => { this.pending.delete(t); resolve(); }, seconds * 1000);
          if (typeof t.unref === 'function') t.unref();
          this.pending.add(t);
        });
        return { detail: `waited ${seconds}s` };
      }

      case 'start_slideshow': {
        io && io.to(roomId).emit('start_slideshow', { slideshowId: action.slideshowId || null });
        return { detail: action.slideshowId || 'chooser' };
      }

      case 'room_command': {
        const cmd = action.command;
        if (!['clear_hints', 'clear_chat', 'reload_players', 'close_overlays'].includes(cmd)) throw new Error(`Unknown command "${cmd}"`);
        io && io.to(roomId).emit(cmd === 'reload_players' ? 'reload_player' : cmd);
        return { detail: cmd };
      }

      case 'run_automation': {
        const target = this.get(action.automationId);
        if (!target || target.room_id !== roomId) throw new Error('Linked automation not found');
        if (target.id === automation.id) throw new Error('An automation cannot run itself');
        if (depth + 1 > MAX_DEPTH) throw new Error('Too many chained automations');
        const res = await this.execute(roomId, target, { type: 'chain', from: automation.name }, { depth: depth + 1, force: !!action.skipConditions });
        return { detail: `${target.name}${res.ran ? '' : ` (skipped: ${res.reason})`}` };
      }

      default:
        throw new Error(`Unknown action type "${action.type}"`);
    }
  }

  /* ------------------------------------------------------- event sources */

  onTimerTick(roomId, timer, { remaining, previous, duration }) {
    const jobs = [this.handleEvent(roomId, { type: 'timer', timer, phase: 'tick', remaining, previous, duration })];
    // Variable-style triggers on the built-in timer variables still work
    const hasVarTriggers = this.list(roomId).some(a => a.enabled && a.trigger && a.trigger.type === 'variable' && String(a.trigger.variable || '').startsWith(`timer_${timer}`));
    if (hasVarTriggers) {
      jobs.push(this.handleEvent(roomId, { type: 'variable', name: `timer_${timer}_remaining`, value: remaining, previous, source: 'timer' }));
      jobs.push(this.handleEvent(roomId, { type: 'variable', name: `timer_${timer}`, value: duration - remaining, previous: duration - previous, source: 'timer' }));
    }
    return Promise.all(jobs);
  }

  onTimerState(roomId, timer, phase, state) {
    // stop and reset both mean "back to the start"
    const mapped = phase === 'stop' ? 'reset' : phase;
    return this.handleEvent(roomId, { type: 'timer', timer, phase: mapped, ...(state || {}) });
  }

  onRoomEvent(roomId, eventName, payload = {}) {
    return this.handleEvent(roomId, { type: 'event', event: eventName, payload });
  }

  async runManual(roomId, automationId, { force = false, payload = {} } = {}) {
    const automation = this.list(roomId).find(a => a.id === automationId) || this.get(automationId);
    if (!automation || automation.room_id !== roomId) throw Object.assign(new Error('Automation not found'), { statusCode: 404 });
    if (!automation.enabled && !force) throw Object.assign(new Error('Automation is disabled'), { statusCode: 409 });
    return this.execute(roomId, automation, { type: force ? 'test' : 'manual', automationId, payload }, { force });
  }

  async runWebhook(hookKey, payload = {}) {
    const automation = this.getByHookKey(hookKey);
    if (!automation) throw Object.assign(new Error('Webhook not found'), { statusCode: 404 });
    if (!automation.enabled) throw Object.assign(new Error('Automation is disabled'), { statusCode: 409 });
    const result = await this.execute(automation.room_id, automation, { type: 'webhook', automationId: automation.id, payload });
    return { automation, result };
  }

  shutdown() {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
  }
}

function describeEvent(event) {
  if (!event || !event.type) return 'unknown';
  switch (event.type) {
    case 'variable': return `${event.name} = ${JSON.stringify(event.value)}`;
    case 'timer': return event.phase === 'tick' ? `${event.timer} timer at ${formatSeconds(event.remaining)}` : `${event.timer} timer ${event.phase}`;
    case 'webhook': return 'incoming webhook';
    case 'manual': return 'GM button';
    case 'test': return 'test run';
    case 'event': return event.event.replace(/_/g, ' ');
    case 'chain': return `automation "${event.from}"`;
    default: return event.type;
  }
}

module.exports = {
  AutomationEngine,
  renderTemplate,
  compare,
  formatSeconds,
  OPERATORS,
  rowToAutomation
};
