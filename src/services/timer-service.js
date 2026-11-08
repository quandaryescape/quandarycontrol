const { logger } = require('../../utils/logger');

/**
 * In-memory room timers.
 *
 * Timer variables (timer_main, timer_main_remaining, ...) are no longer written to
 * SQLite every second; VariableService reads them live via getTimerState().
 * Automations hook in through setHooks({ onTick, onStateChange }).
 */
class TimerService {
  constructor() {
    this.activeTimers = new Map();
    this.activeSecondaryTimers = new Map();
    this.hooks = { onTick: null, onStateChange: null };
  }

  setHooks(hooks = {}) {
    this.hooks = { ...this.hooks, ...hooks };
  }

  mapFor(type) {
    return type === 'secondary' ? this.activeSecondaryTimers : this.activeTimers;
  }

  eventName(type) {
    return type === 'secondary' ? 'secondary_timer_update' : 'timer_update';
  }

  /**
   * Initialize timer for a room (no-op if it already exists)
   */
  initializeTimer(roomId, duration, type = 'main') {
    const timersMap = this.mapFor(type);
    if (!timersMap.has(roomId)) {
      const d = duration > 0 ? duration : 300;
      timersMap.set(roomId, {
        duration: d,
        configuredDuration: d,
        remaining: d,
        interval: null,
        enabled: true,
        status: 'ready',
        startedAt: null
      });
      logger.debug(`Timer initialized for room ${roomId}`, { type, duration: d });
    }
    return timersMap.get(roomId);
  }

  /**
   * Keep an idle timer in sync after the room's configured duration changes in admin.
   */
  syncDuration(roomId, duration, type = 'main', io) {
    const timer = this.mapFor(type).get(roomId);
    if (!timer || !(duration > 0)) return false;
    timer.configuredDuration = duration;
    if (!timer.interval && (timer.status === 'ready' || timer.remaining === timer.duration)) {
      timer.duration = duration;
      timer.remaining = duration;
      timer.status = 'ready';
      this.emit(roomId, type, io);
    }
    return true;
  }

  setEnabled(roomId, enabled, type = 'secondary', io) {
    const timer = this.mapFor(type).get(roomId);
    if (!timer) return false;
    timer.enabled = !!enabled;
    this.emit(roomId, type, io);
    return true;
  }

  emit(roomId, type, io) {
    const target = io || this.io;
    if (!target) return;
    const state = this.getTimerState(roomId, type);
    target.to(roomId).emit(this.eventName(type), state);
    // Admin dashboard shows live timers on every room card
    target.to('admin_dashboard').emit('room_timer', { roomId, type, ...state });
  }

  notifyState(roomId, type, phase) {
    if (typeof this.hooks.onStateChange === 'function') {
      try {
        this.hooks.onStateChange(roomId, type, phase, this.getTimerState(roomId, type));
      } catch (err) {
        logger.error('Timer state hook failed', { roomId, type, phase, error: err.message });
      }
    }
  }

  /**
   * Start timer for a room
   */
  startTimer(roomId, type = 'main', io) {
    if (io) this.io = io;
    const timer = this.mapFor(type).get(roomId);
    if (!timer || timer.interval) return false;
    if (timer.remaining <= 0) {
      timer.remaining = timer.duration;
    }

    const wasFresh = timer.status === 'ready';
    timer.status = 'running';
    if (!timer.startedAt) timer.startedAt = new Date().toISOString();
    // Anchor on wall clock so drift from setInterval doesn't accumulate
    timer.endsAt = Date.now() + timer.remaining * 1000;

    timer.interval = setInterval(() => this.tick(roomId, type), 1000);
    if (typeof timer.interval.unref === 'function') timer.interval.unref();

    this.emit(roomId, type, io);
    this.notifyState(roomId, type, wasFresh ? 'start' : 'resume');
    logger.info(`Timer started for room ${roomId}`, { type, remaining: timer.remaining });
    return true;
  }

  tick(roomId, type) {
    const timer = this.mapFor(type).get(roomId);
    if (!timer || !timer.interval) return;

    const previous = timer.remaining;
    timer.remaining = Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000));
    if (timer.remaining === previous && timer.remaining > 0) return;

    this.emit(roomId, type);

    if (typeof this.hooks.onTick === 'function') {
      try {
        this.hooks.onTick(roomId, type, { remaining: timer.remaining, previous, duration: timer.duration });
      } catch (err) {
        logger.error('Timer tick hook failed', { roomId, type, error: err.message });
      }
    }

    if (timer.remaining <= 0) {
      clearInterval(timer.interval);
      timer.interval = null;
      timer.status = 'complete';
      this.emit(roomId, type);
      if (this.io) this.io.to(roomId).emit(type === 'secondary' ? 'secondary_timer_complete' : 'timer_complete');
      this.notifyState(roomId, type, 'complete');
    }
  }

  /**
   * Pause timer for a room
   */
  pauseTimer(roomId, type = 'main', io) {
    const timer = this.mapFor(type).get(roomId);
    if (!timer || !timer.interval) return false;

    clearInterval(timer.interval);
    timer.interval = null;
    timer.remaining = Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000));
    timer.status = 'paused';

    this.emit(roomId, type, io);
    this.notifyState(roomId, type, 'pause');
    logger.info(`Timer paused for room ${roomId}`, { type, remaining: timer.remaining });
    return true;
  }

  /**
   * Stop and reset timer to its current duration
   */
  stopTimer(roomId, type = 'main', io) {
    const timer = this.mapFor(type).get(roomId);
    if (!timer) return false;

    if (timer.interval) {
      clearInterval(timer.interval);
      timer.interval = null;
    }
    timer.remaining = timer.duration;
    timer.status = 'ready';
    timer.startedAt = null;

    this.emit(roomId, type, io);
    this.notifyState(roomId, type, 'stop');
    logger.info(`Timer stopped for room ${roomId}`, { type });
    return true;
  }

  /**
   * Add (or remove, with a negative amount) time.
   * Running and paused timers keep their progress; only remaining time moves.
   */
  adjustTimer(roomId, amount, type = 'main', io) {
    const timer = this.mapFor(type).get(roomId);
    if (!timer || typeof amount !== 'number' || Number.isNaN(amount)) return false;

    const newDuration = Math.max(1, timer.duration + amount);
    const delta = newDuration - timer.duration;
    timer.duration = newDuration;

    if (timer.interval) {
      timer.endsAt += delta * 1000;
      timer.remaining = Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000));
    } else {
      timer.remaining = Math.max(0, Math.min(timer.duration, timer.remaining + delta));
    }

    this.emit(roomId, type, io);
    this.notifyState(roomId, type, 'adjust');
    logger.info(`Timer adjusted for room ${roomId}`, { type, amount, newDuration });
    return true;
  }

  /**
   * Reset timer to its configured duration (or a new one)
   */
  resetTimer(roomId, newDuration, type = 'main', io) {
    const timer = this.mapFor(type).get(roomId);
    if (!timer) return false;

    if (timer.interval) {
      clearInterval(timer.interval);
      timer.interval = null;
    }

    const d = newDuration && newDuration > 0 ? newDuration : (timer.configuredDuration || timer.duration);
    timer.duration = d;
    timer.remaining = d;
    timer.status = 'ready';
    timer.startedAt = null;

    this.emit(roomId, type, io);
    this.notifyState(roomId, type, 'reset');
    logger.info(`Timer reset for room ${roomId}`, { type, newDuration: d });
    return true;
  }

  /**
   * Get timer state
   */
  getTimerState(roomId, type = 'main') {
    const timer = this.mapFor(type).get(roomId);
    if (!timer) return null;

    const remaining = timer.interval
      ? Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000))
      : timer.remaining;

    const state = {
      remaining,
      duration: timer.duration,
      running: !!timer.interval,
      status: timer.status,
      startedAt: timer.startedAt
    };
    if (type === 'secondary') state.enabled = timer.enabled;
    return state;
  }

  clearRoomTimers(roomId) {
    for (const type of ['main', 'secondary']) {
      const timer = this.mapFor(type).get(roomId);
      if (timer && timer.interval) clearInterval(timer.interval);
      this.mapFor(type).delete(roomId);
    }
    logger.debug(`Cleared all timers for room ${roomId}`);
  }

  clearAllTimers() {
    const rooms = new Set([...this.activeTimers.keys(), ...this.activeSecondaryTimers.keys()]);
    for (const roomId of rooms) this.clearRoomTimers(roomId);
    logger.info('All timers cleared');
  }
}

module.exports = TimerService;
