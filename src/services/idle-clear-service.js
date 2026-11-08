/**
 * Between-games cleanup: when a room has been idle (no timer running, no hints,
 * chat or media) for N minutes, clear hints/chat and close pop-ups on the
 * player screens so the next group never walks in to the last group's hint.
 *
 * Settings (app_settings): auto_clear_enabled (default on), auto_clear_minutes (default 15).
 */
const settings = require('./settings-service');
const { logger } = require('../../utils/logger');

const idleLogger = logger.child({ module: 'idle-clear' });

const DEFAULT_MINUTES = 15;
const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const CHECK_EVERY_MS = 30 * 1000;

function getConfig() {
  const enabled = settings.get('auto_clear_enabled');
  const minutes = Number(settings.get('auto_clear_minutes'));
  return {
    enabled: enabled === null ? true : enabled !== 'false',
    minutes: Number.isFinite(minutes) && minutes >= MIN_MINUTES ? Math.min(MAX_MINUTES, Math.round(minutes)) : DEFAULT_MINUTES
  };
}

function setConfig({ enabled, minutes } = {}) {
  if (enabled !== undefined) settings.set('auto_clear_enabled', enabled ? 'true' : 'false');
  if (minutes !== undefined) {
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < MIN_MINUTES || m > MAX_MINUTES) {
      throw Object.assign(new Error(`Minutes must be between ${MIN_MINUTES} and ${MAX_MINUTES}`), { statusCode: 400 });
    }
    settings.set('auto_clear_minutes', String(m));
  }
  return getConfig();
}

class IdleClearService {
  constructor({ io, timerService }) {
    this.io = io;
    this.timerService = timerService;
    this.rooms = new Map(); // roomId -> { lastActivity, hints, chat, overlays }
    this.interval = null;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), CHECK_EVERY_MS);
    if (typeof this.interval.unref === 'function') this.interval.unref();
  }

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  }

  entry(roomId) {
    let e = this.rooms.get(roomId);
    if (!e) {
      e = { lastActivity: Date.now(), hints: false, chat: false, overlays: false };
      this.rooms.set(roomId, e);
    }
    return e;
  }

  /**
   * Record activity. Flags say what is now showing on player screens.
   * @param {object} what { hints, chat, overlays }
   */
  touch(roomId, what = {}) {
    if (!roomId) return;
    const e = this.entry(roomId);
    e.lastActivity = Date.now();
    if (what.hints) e.hints = true;
    if (what.chat) e.chat = true;
    if (what.overlays) e.overlays = true;
  }

  /** A player screen connected. After a server restart we can't know what it still shows. */
  playerJoined(roomId) {
    if (!this.rooms.has(roomId)) this.touch(roomId, { hints: true, chat: true, overlays: true });
  }

  /** The GM cleared something by hand. */
  cleared(roomId, what = {}) {
    const e = this.rooms.get(roomId);
    if (!e) return;
    if (what.hints) e.hints = false;
    if (what.chat) e.chat = false;
    if (what.overlays) e.overlays = false;
  }

  forget(roomId) {
    this.rooms.delete(roomId);
  }

  timerRunning(roomId) {
    if (!this.timerService) return false;
    const main = this.timerService.getTimerState(roomId, 'main');
    const secondary = this.timerService.getTimerState(roomId, 'secondary');
    return !!((main && main.running) || (secondary && secondary.running));
  }

  /** Clear rooms that have been idle long enough. Returns the room ids cleared. */
  check(now = Date.now()) {
    const cfg = getConfig();
    if (!cfg.enabled) return [];
    const limit = cfg.minutes * 60 * 1000;
    const cleared = [];
    for (const [roomId, e] of this.rooms) {
      if (!(e.hints || e.chat || e.overlays)) continue;
      if (this.timerRunning(roomId)) continue;
      if (now - e.lastActivity < limit) continue;
      this.clear(roomId, e, cfg.minutes);
      cleared.push(roomId);
    }
    return cleared;
  }

  clear(roomId, e, minutes) {
    const io = this.io;
    const payload = { silent: true, reason: 'idle' };
    if (io) {
      if (e.hints) io.to(roomId).emit('clear_hints', payload);
      if (e.chat) io.to(roomId).emit('clear_chat', payload);
      io.to(roomId).emit('close_overlays', payload);
      io.to(`gm_${roomId}`).emit('auto_cleared', { minutes, hints: e.hints, chat: e.chat, at: new Date().toISOString() });
    }
    idleLogger.info('Cleared idle room', { roomId, minutes, hints: e.hints, chat: e.chat });
    e.hints = false;
    e.chat = false;
    e.overlays = false;
  }
}

module.exports = { IdleClearService, getConfig, setConfig, DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES };
