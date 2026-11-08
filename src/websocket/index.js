const { logger } = require('../../utils/logger');
const { setupRoomHandlers } = require('./handlers/room-handlers');
const { setupTimerHandlers } = require('./handlers/timer-handlers');
const { setupChatHandlers } = require('./handlers/chat-handlers');
const { setupLayoutHandlers } = require('./handlers/layout-handlers');
const { setupControlHandlers } = require('./handlers/control-handlers');

/**
 * Initialize WebSocket server with all handlers
 */
function initializeWebSocket(io, timerService, services = {}) {
  const wsLogger = logger.child({ module: 'websocket-main' });

  io.on('connection', (socket) => {
    wsLogger.debug('New WebSocket connection', {
      socketId: socket.id,
      ip: socket.handshake.address
    });

    try {
      setupRoomHandlers(socket, io, timerService, services);
      setupTimerHandlers(socket, io, timerService);
      setupChatHandlers(socket, io, services);
      setupLayoutHandlers(socket, io);
      setupControlHandlers(socket, io, services);
    } catch (error) {
      wsLogger.error('Error setting up WebSocket handlers', {
        socketId: socket.id,
        error: error.message,
        stack: error.stack
      });
    }

    socket.on('error', (error) => {
      wsLogger.error('WebSocket error', {
        socketId: socket.id,
        error: error.message,
        roomId: socket.roomId,
        clientType: socket.clientType
      });
    });

    socket.on('disconnect', (reason) => {
      wsLogger.debug('WebSocket disconnection', {
        socketId: socket.id,
        reason,
        roomId: socket.roomId,
        clientType: socket.clientType
      });
    });
  });

  io.engine.on('connection_error', (err) => {
    wsLogger.warn('WebSocket connection error', { code: err.code, message: err.message });
  });

  return io;
}

module.exports = { initializeWebSocket };
