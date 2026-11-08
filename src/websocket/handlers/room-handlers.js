const { logger } = require('../../../utils/logger');
const { getDatabase } = require('../../../db/database');

const roomLogger = logger.child({ module: 'room-websocket' });

/**
 * Count connected players/GMs in a room for presence indicators.
 */
function presence(io, roomId) {
  const ids = io.sockets.adapter.rooms.get(roomId);
  const counts = { players: 0, gms: 0 };
  if (!ids) return counts;
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (!s) continue;
    if (s.clientType === 'player') counts.players += 1;
    else if (s.clientType === 'gm') counts.gms += 1;
  }
  return counts;
}

function broadcastPresence(io, roomId) {
  const counts = presence(io, roomId);
  io.to(`gm_${roomId}`).emit('presence', counts);
  io.to(`admin_${roomId}`).emit('presence', counts);
  io.to('admin_dashboard').emit('room_presence', { roomId, ...counts });
}

/**
 * Room connection and management handlers for WebSocket connections
 */
function setupRoomHandlers(socket, io, timerService, services = {}) {
  socket.on('join_room', ({ roomId, clientType } = {}) => {
    // 'preview' = theme builder / thumbnails: receives updates but isn't counted as a screen
    if (!roomId || !['gm', 'player', 'preview'].includes(clientType)) {
      roomLogger.warn('Invalid join parameters', { roomId, clientType, socketId: socket.id });
      return socket.emit('error', 'Invalid join parameters');
    }

    let room;
    try {
      room = getDatabase().prepare('SELECT id, timer_duration, secondary_timer_enabled, secondary_timer_duration FROM rooms WHERE id = ?').get(roomId);
    } catch (error) {
      roomLogger.error('Error loading room on join', { roomId, error: error.message });
      return socket.emit('error', 'Failed to initialize room');
    }
    if (!room) {
      roomLogger.warn('Room not found in database', { roomId, socketId: socket.id });
      return socket.emit('error', 'Room not found');
    }

    // Leave a previous room if this socket is re-joining
    if (socket.roomId && socket.roomId !== roomId) {
      socket.leave(socket.roomId);
      socket.leave(`gm_${socket.roomId}`);
    }

    socket.join(roomId);
    if (clientType === 'gm') socket.join(`gm_${roomId}`);
    socket.roomId = roomId;
    socket.clientType = clientType;

    timerService.initializeTimer(roomId, room.timer_duration > 0 ? room.timer_duration : 300, 'main');
    socket.emit('timer_update', timerService.getTimerState(roomId, 'main'));

    if (room.secondary_timer_enabled) {
      timerService.initializeTimer(roomId, room.secondary_timer_duration > 0 ? room.secondary_timer_duration : 300, 'secondary');
      const secondaryState = timerService.getTimerState(roomId, 'secondary');
      if (secondaryState) socket.emit('secondary_timer_update', secondaryState);
    }

    if (services.variableService) {
      socket.emit('variableUpdate', { variables: services.variableService.getAllVariables(roomId) || {} });
    }

    roomLogger.info('Client joined room', { roomId, clientType, socketId: socket.id });
    broadcastPresence(io, roomId);

    if (clientType === 'player' && services.idleClear) services.idleClear.playerJoined(roomId);
    if (clientType === 'player' && services.automationEngine) {
      services.automationEngine.onRoomEvent(roomId, 'player_connected', {}).catch(() => {});
    }
  });

  // Admin-specific room joining (automation builder, slideshow studio, dashboard)
  socket.on('join_admin', ({ roomId } = {}) => {
    if (!roomId) {
      return socket.emit('error', 'Invalid admin join parameters');
    }
    socket.join(`admin_${roomId}`);
    socket.adminRoomId = roomId;

    try {
      const room = getDatabase().prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) return socket.emit('error', 'Room not found');
      let config = {};
      try { config = JSON.parse(room.config || '{}'); } catch (_) { config = {}; }
      socket.emit('room_config', { roomId, config, layout: config.layout || {} });
      socket.emit('presence', presence(io, roomId));
    } catch (error) {
      roomLogger.error('Error sending room config to admin', { roomId, error: error.message });
      socket.emit('error', 'Failed to load room configuration');
    }
  });

  // Dashboard: live status for every room card
  socket.on('join_dashboard', () => {
    socket.join('admin_dashboard');
    try {
      const rooms = getDatabase().prepare('SELECT id FROM rooms').all();
      const snapshot = rooms.map(r => ({
        roomId: r.id,
        ...presence(io, r.id),
        timer: timerService.getTimerState(r.id, 'main')
      }));
      socket.emit('dashboard_snapshot', snapshot);
    } catch (error) {
      roomLogger.error('Dashboard snapshot failed', { error: error.message });
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      // Defer so the adapter has removed this socket first
      setImmediate(() => broadcastPresence(io, socket.roomId));
    }
  });
}

module.exports = { setupRoomHandlers, presence, broadcastPresence };
