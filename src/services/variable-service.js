const { getDatabase } = require('../../db/database');
const { logger } = require('../../utils/logger');

const varLogger = logger.child({ module: 'variable-service' });

const TIMER_VARIABLE_NAMES = ['timer_main', 'timer_main_remaining', 'timer_secondary', 'timer_secondary_remaining'];
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const TRUE_STRINGS = new Set(['true', '1', 'yes', 'on', 'open', 'opened', 'solved', 'active', 'high']);
const FALSE_STRINGS = new Set(['false', '0', 'no', 'off', 'closed', '', 'inactive', 'low', 'null', 'undefined']);

/**
 * Coerce an incoming value to a type. Fixes the legacy `Boolean("false") === true` bug.
 */
function coerceValue(value, type) {
  switch (type) {
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      const s = String(value ?? '').trim().toLowerCase();
      if (TRUE_STRINGS.has(s)) return true;
      if (FALSE_STRINGS.has(s)) return false;
      throw new Error(`"${value}" is not a valid boolean (use true/false)`);
    }
    case 'integer':
    case 'number': {
      if (value === '' || value === null || value === undefined) throw new Error('Number value is required');
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`"${value}" is not a valid number`);
      return type === 'integer' ? Math.trunc(n) : n;
    }
    case 'array':
    case 'object':
    case 'json': {
      if (typeof value === 'object' && value !== null) return value;
      try { return JSON.parse(value); } catch (_) { throw new Error('Value must be valid JSON'); }
    }
    case 'string':
      return value === null || value === undefined ? '' : String(value);
    case 'auto':
    default:
      return autoCoerce(value);
  }
}

/**
 * Best-effort type inference for values coming from hardware/webhooks as strings.
 */
function autoCoerce(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { return JSON.parse(s); } catch (_) { /* keep string */ }
  }
  return value;
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object') return 'object';
  return 'string';
}

function parseVariables(raw) {
  let vars = {};
  try { vars = JSON.parse(raw || '{}'); } catch (_) { vars = {}; }
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return {};
  // Drop legacy persisted timer objects – timers are served live now
  for (const name of TIMER_VARIABLE_NAMES) {
    if (vars[name] && typeof vars[name] === 'object' && vars[name].system) delete vars[name];
  }
  return vars;
}

class VariableService {
  /**
   * @param {object} deps
   * @param {import('socket.io').Server} deps.io
   * @param {import('./timer-service')} deps.timerService
   */
  constructor({ io, timerService }) {
    this.io = io;
    this.timerService = timerService;
    this.engine = null; // set later to avoid a circular constructor dependency
  }

  setEngine(engine) {
    this.engine = engine;
  }

  roomExists(roomId) {
    return !!getDatabase().prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId);
  }

  /** User-defined variables only (as stored). */
  getUserVariables(roomId) {
    const row = getDatabase().prepare('SELECT api_variables FROM rooms WHERE id = ?').get(roomId);
    if (!row) return null;
    return parseVariables(row.api_variables);
  }

  /** Live timer variables computed from the in-memory timer service. */
  getTimerVariables(roomId) {
    const result = {};
    for (const type of ['main', 'secondary']) {
      const state = this.timerService ? this.timerService.getTimerState(roomId, type) : null;
      if (!state) continue;
      const elapsed = Math.max(0, state.duration - state.remaining);
      result[`timer_${type}`] = elapsed;
      result[`timer_${type}_remaining`] = state.remaining;
    }
    return result;
  }

  /** User variables merged with live timer values. */
  getAllVariables(roomId) {
    const user = this.getUserVariables(roomId);
    if (user === null) return null;
    return { ...user, ...this.getTimerVariables(roomId) };
  }

  /** Legacy array response shape used by `/api/rooms/:id/variables`. */
  toLegacyArray(roomId, vars) {
    return Object.entries(vars).map(([name, value], index) => ({
      id: index + 1,
      room_id: roomId,
      name,
      type: typeOf(value) === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeOf(value),
      value: typeof value === 'string' ? value : JSON.stringify(value),
      parsed_value: value,
      system: TIMER_VARIABLE_NAMES.includes(name)
    }));
  }

  validateName(name) {
    if (!NAME_PATTERN.test(String(name || ''))) {
      throw Object.assign(new Error('Variable names must start with a letter or underscore and contain only letters, numbers, _ . -'), { statusCode: 400 });
    }
    if (TIMER_VARIABLE_NAMES.includes(name)) {
      throw Object.assign(new Error(`"${name}" is a built-in timer variable and is read-only`), { statusCode: 400 });
    }
  }

  /**
   * Set a variable, persist, broadcast, and run automations.
   * @returns {{name:string, value:any, previous:any, changed:boolean}}
   */
  setVariable(roomId, name, rawValue, { type = 'auto', source = 'api', depth = 0, silent = false } = {}) {
    this.validateName(name);
    const db = getDatabase();
    const row = db.prepare('SELECT api_variables FROM rooms WHERE id = ?').get(roomId);
    if (!row) throw Object.assign(new Error('Room not found'), { statusCode: 404 });

    let value;
    try {
      value = coerceValue(rawValue, type);
    } catch (e) {
      throw Object.assign(e, { statusCode: 400 });
    }

    const vars = parseVariables(row.api_variables);
    const previous = vars[name];
    vars[name] = value;
    db.prepare('UPDATE rooms SET api_variables = ? WHERE id = ?').run(JSON.stringify(vars), roomId);

    const changed = JSON.stringify(previous) !== JSON.stringify(value);
    if (!silent) this.broadcast(roomId, name, value, source);

    if (this.engine && changed) {
      this.engine.handleEvent(roomId, {
        type: 'variable',
        name,
        value,
        previous,
        source
      }, { depth }).catch(err => varLogger.error('Automation error after variable change', { roomId, name, error: err.message }));
    }

    return { name, value, previous, changed };
  }

  /** Apply a relative change (increment/decrement/toggle). */
  modifyVariable(roomId, name, mode, amount, opts = {}) {
    const vars = this.getUserVariables(roomId) || {};
    const current = vars[name];
    let next;
    switch (mode) {
      case 'increment': next = (Number(current) || 0) + (Number(amount) || 1); break;
      case 'decrement': next = (Number(current) || 0) - (Number(amount) || 1); break;
      case 'toggle': next = !(current === true || String(current).toLowerCase() === 'true'); break;
      default: return this.setVariable(roomId, name, amount, opts);
    }
    return this.setVariable(roomId, name, next, { ...opts, type: 'auto' });
  }

  deleteVariable(roomId, name) {
    const db = getDatabase();
    const row = db.prepare('SELECT api_variables FROM rooms WHERE id = ?').get(roomId);
    if (!row) throw Object.assign(new Error('Room not found'), { statusCode: 404 });
    const vars = parseVariables(row.api_variables);
    if (!(name in vars)) return false;
    delete vars[name];
    db.prepare('UPDATE rooms SET api_variables = ? WHERE id = ?').run(JSON.stringify(vars), roomId);
    if (this.io) {
      this.io.to(roomId).emit('variable_deleted', { name });
      this.io.to(roomId).emit('variableUpdate', { name, deleted: true, variables: this.getAllVariables(roomId) });
    }
    return true;
  }

  /** Replace the whole user-variable map (admin editor save). */
  replaceVariables(roomId, vars) {
    const clean = {};
    for (const [k, v] of Object.entries(vars || {})) {
      if (TIMER_VARIABLE_NAMES.includes(k)) continue;
      this.validateName(k);
      clean[k] = v;
    }
    getDatabase().prepare('UPDATE rooms SET api_variables = ? WHERE id = ?').run(JSON.stringify(clean), roomId);
    if (this.io) this.io.to(roomId).emit('variableUpdate', { variables: this.getAllVariables(roomId) });
    return clean;
  }

  broadcast(roomId, name, value, source) {
    if (!this.io) return;
    const timestamp = new Date().toISOString();
    // Both event shapes are emitted for backwards compatibility with existing themes.
    this.io.to(roomId).emit('variable_updated', { var: name, value, source, timestamp });
    this.io.to(roomId).emit('variableUpdate', {
      name,
      value,
      type: typeOf(value),
      source,
      timestamp,
      variables: this.getAllVariables(roomId)
    });
  }
}

module.exports = {
  VariableService,
  coerceValue,
  autoCoerce,
  typeOf,
  parseVariables,
  TIMER_VARIABLE_NAMES
};
