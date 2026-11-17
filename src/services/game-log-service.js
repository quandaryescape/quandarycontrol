/**
 * Game history: turns timer activity into a list of played games.
 *
 * A game begins when a room's main timer is started. It is only saved once it
 * has run long enough (setting game_log_min_minutes, default 10 – or the whole
 * timer if that is shorter), so test starts and false starts that are reset
 * straight away never appear in the list.
 *
 * A game ends when time runs out or the GM resets/stops the timer. If the timer
 * was paused first (the usual "they got out" flow) the game ends when it was
 * paused, and the time left on the clock at that moment is kept.
 *
 * Timers live in memory, so games left open by a previous run are closed as
 * "interrupted" when the server starts.
 */
const { nanoid } = require('nanoid');
const { getDatabase } = require('../../db/database');
const settings = require('./settings-service');
const { logger } = require('../../utils/logger');

const gameLogger = logger.child({ module: 'game-log' });

const DEFAULT_MINUTES = 10;
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;
const SAVE_EVERY_SECONDS = 60;
const RESULTS = new Set(['escaped', 'failed']);

function getConfig() {
  const minutes = Number(settings.get('game_log_min_minutes'));
  return {
    minMinutes: Number.isFinite(minutes) && minutes >= MIN_MINUTES ? Math.min(MAX_MINUTES, Math.round(minutes)) : DEFAULT_MINUTES
  };
}

function setConfig({ minMinutes } = {}) {
  if (minMinutes !== undefined) {
    const m = Math.round(Number(minMinutes));
    if (!Number.isFinite(m) || m < MIN_MINUTES || m > MAX_MINUTES) {
      throw Object.assign(new Error(`Minutes must be between ${MIN_MINUTES} and ${MAX_MINUTES}`), { statusCode: 400 });
    }
    settings.set('game_log_min_minutes', String(m));
  }
  return getConfig();
}

function toGameDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: row.current_room_name || row.room_name || '',
    roomExists: row.current_room_name !== null && row.current_room_name !== undefined,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    endReason: row.end_reason || null,
    duration: row.duration_seconds,
    elapsed: row.elapsed_seconds,
    remaining: row.remaining_seconds,
    hints: row.hints,
    playerMessages: row.player_messages,
    gmMessages: row.gm_messages,
    result: row.result || null,
    teamName: row.team_name || '',
    notes: row.notes || ''
  };
}

const SELECT_GAME = `
  SELECT g.*, r.name AS current_room_name
  FROM games g LEFT JOIN rooms r ON r.id = g.room_id`;

class GameLogService {
  constructor({ io } = {}) {
    this.io = io;
    this.rooms = new Map(); // roomId -> live game (saved once gameId is set)
  }

  /** Close games a previous run left open. Returns how many were closed. */
  closeInterrupted() {
    const res = getDatabase().prepare(`
      UPDATE games SET status = 'ended', end_reason = 'interrupted', ended_at = COALESCE(ended_at, updated_at)
      WHERE status = 'in_progress'
    `).run();
    if (res.changes) gameLogger.info('Closed games interrupted by a restart', { count: res.changes });
    return res.changes;
  }

  /* ------------------------------------------------------------ timer hooks */

  onTimerState(roomId, type, phase, state = {}) {
    if (type !== 'main' || !roomId) return;
    const now = Date.now();
    const live = this.rooms.get(roomId);
    switch (phase) {
      case 'start':
        if (live) this.finish(roomId, 'reset', live.pausedAt || now);
        this.begin(roomId, state, now);
        break;
      case 'resume':
        // No live game means time ran out and the GM started the clock again
        if (!live) { this.begin(roomId, state, now); break; }
        live.pausedAt = null;
        this.snapshot(live, state);
        break;
      case 'pause':
        if (!live) return;
        this.snapshot(live, state);
        live.pausedAt = now;
        if (!this.maybeRecord(roomId, live)) this.save(live);
        break;
      case 'adjust':
        if (!live) return;
        this.snapshot(live, state);
        this.save(live);
        break;
      case 'complete':
        if (!live) return;
        this.snapshot(live, state);
        this.finish(roomId, 'time_up', now);
        break;
      case 'stop':
      case 'reset':
        // `state` is already the fresh timer, so finish with what we saw last
        if (live) this.finish(roomId, phase === 'stop' ? 'stopped' : 'reset', live.pausedAt || now);
        break;
      default:
        break;
    }
  }

  onTick(roomId, type, data = {}) {
    if (type !== 'main') return;
    const live = this.rooms.get(roomId);
    if (!live) return;
    this.snapshot(live, data);
    if (this.maybeRecord(roomId, live)) return;
    if (live.gameId && live.elapsed - live.savedElapsed >= SAVE_EVERY_SECONDS) this.save(live);
  }

  /** Hints and chat (called from AutomationEngine.onRoomEvent). */
  onRoomEvent(roomId, eventName) {
    const live = this.rooms.get(roomId);
    if (!live) return;
    if (eventName === 'hint_sent') live.hints++;
    else if (eventName === 'player_message') live.playerMessages++;
    else if (eventName === 'gm_message') live.gmMessages++;
    else return;
    this.save(live);
  }

  /** The room was deleted: close its game but keep it in the history. */
  forget(roomId) {
    if (this.rooms.has(roomId)) this.finish(roomId, 'interrupted', Date.now());
  }

  /* --------------------------------------------------------------- internals */

  begin(roomId, state, now) {
    const live = {
      roomId,
      gameId: null,
      discarded: false,
      startedAt: now,
      pausedAt: null,
      duration: 0,
      remaining: 0,
      elapsed: 0,
      savedElapsed: 0,
      hints: 0,
      playerMessages: 0,
      gmMessages: 0
    };
    this.snapshot(live, state);
    live.startedAt = now - live.elapsed * 1000;
    this.rooms.set(roomId, live);
    return live;
  }

  snapshot(live, s) {
    if (!s) return;
    if (Number(s.duration) > 0) live.duration = Math.round(s.duration);
    if (Number.isFinite(Number(s.remaining))) live.remaining = Math.max(0, Math.round(s.remaining));
    live.elapsed = Math.max(0, live.duration - live.remaining);
  }

  /** Save the game once it has run long enough. Returns true if it was just saved. */
  maybeRecord(roomId, live) {
    if (live.gameId || live.discarded) return false;
    const threshold = Math.min(getConfig().minMinutes * 60, live.duration || Infinity);
    if (live.elapsed < threshold) return false;

    const db = getDatabase();
    const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(roomId);
    if (!room) { live.discarded = true; return false; }

    live.gameId = nanoid(12);
    live.savedElapsed = live.elapsed;
    db.prepare(`
      INSERT INTO games (id, room_id, room_name, status, started_at, duration_seconds, elapsed_seconds, remaining_seconds,
        hints, player_messages, gm_messages, updated_at)
      VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(live.gameId, roomId, room.name, new Date(live.startedAt).toISOString(), live.duration, live.elapsed, live.remaining,
      live.hints, live.playerMessages, live.gmMessages, new Date().toISOString());

    const game = this.get(live.gameId);
    gameLogger.info('Game started', { roomId, gameId: live.gameId });
    this.broadcast(roomId, 'game_started', game);
    return true;
  }

  save(live) {
    if (!live.gameId) return;
    getDatabase().prepare(`
      UPDATE games SET duration_seconds = ?, elapsed_seconds = ?, remaining_seconds = ?, hints = ?, player_messages = ?,
        gm_messages = ?, updated_at = ?
      WHERE id = ?
    `).run(live.duration, live.elapsed, live.remaining, live.hints, live.playerMessages, live.gmMessages, new Date().toISOString(), live.gameId);
    live.savedElapsed = live.elapsed;
  }

  finish(roomId, reason, endedAt) {
    const live = this.rooms.get(roomId);
    if (!live) return null;
    this.rooms.delete(roomId);
    this.maybeRecord(roomId, live);
    if (!live.gameId) return null;

    getDatabase().prepare(`
      UPDATE games SET status = 'ended', ended_at = ?, end_reason = ?, duration_seconds = ?, elapsed_seconds = ?,
        remaining_seconds = ?, hints = ?, player_messages = ?, gm_messages = ?, updated_at = ?
      WHERE id = ?
    `).run(new Date(endedAt).toISOString(), reason, live.duration, live.elapsed, live.remaining, live.hints, live.playerMessages,
      live.gmMessages, new Date().toISOString(), live.gameId);

    const game = this.get(live.gameId);
    gameLogger.info('Game ended', { roomId, gameId: live.gameId, reason, elapsed: live.elapsed });
    if (game) this.broadcast(roomId, 'game_ended', game);
    return game;
  }

  broadcast(roomId, event, game) {
    if (!this.io || !game) return;
    this.io.to(`gm_${roomId}`).emit(event, game);
    this.io.to('admin_dashboard').emit('game_updated', game);
  }

  /* ------------------------------------------------------------------ CRUD */

  get(id) {
    return toGameDTO(getDatabase().prepare(`${SELECT_GAME} WHERE g.id = ?`).get(id));
  }

  list({ roomId, limit = 50, offset = 0 } = {}) {
    const db = getDatabase();
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const where = roomId ? 'WHERE g.room_id = ?' : '';
    const args = roomId ? [roomId] : [];
    const rows = db.prepare(`${SELECT_GAME} ${where} ORDER BY g.started_at DESC, g.rowid DESC LIMIT ? OFFSET ?`).all(...args, lim, off);
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM games g ${where}`).get(...args);
    return { items: rows.map(toGameDTO), total: n };
  }

  update(id, body = {}) {
    const game = this.get(id);
    if (!game) return null;
    const sets = [];
    const vals = [];
    if (body.result !== undefined) {
      const result = body.result || null;
      if (result !== null && !RESULTS.has(result)) {
        throw Object.assign(new Error('Result must be "escaped", "failed" or empty'), { statusCode: 400 });
      }
      sets.push('result = ?'); vals.push(result);
    }
    if (body.teamName !== undefined) { sets.push('team_name = ?'); vals.push(String(body.teamName || '').trim().slice(0, 100)); }
    if (body.notes !== undefined) { sets.push('notes = ?'); vals.push(String(body.notes || '').slice(0, 5000)); }
    if (!sets.length) return game;
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    getDatabase().prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const updated = this.get(id);
    this.broadcast(updated.roomId, 'game_updated', updated);
    return updated;
  }

  remove(id) {
    const game = this.get(id);
    if (!game) return false;
    getDatabase().prepare('DELETE FROM games WHERE id = ?').run(id);
    // Deleting a game that is still being played: don't save it again
    const live = this.rooms.get(game.roomId);
    if (live && live.gameId === id) { live.gameId = null; live.discarded = true; }
    if (this.io) this.io.to('admin_dashboard').emit('game_deleted', { id, roomId: game.roomId });
    return true;
  }
}

module.exports = { GameLogService, getConfig, setConfig, toGameDTO, DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES };
