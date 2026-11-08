const { logger } = require('../../../utils/logger');

/**
 * Timer control handlers for WebSocket connections
 */
function setupTimerHandlers(socket, io, timerService) {
  const roomLogger = logger.child({ module: 'timer-websocket' });

  // Primary timer control handler
  socket.on('timer_control', ({ roomId, action, amount }) => {
    roomLogger.debug('Timer control received', { roomId, action, amount, socketId: socket.id });

    if (!roomId || !action) {
      roomLogger.warn('Invalid timer control parameters', { roomId, action, socketId: socket.id });
      return socket.emit('error', 'Invalid timer control parameters');
    }

    const timer = timerService.getTimerState(roomId);
    if (!timer) {
      roomLogger.warn('No timer found for room', { roomId, socketId: socket.id });
      return socket.emit('error', 'Timer not found for room');
    }

    let result = false;

    switch (action) {
      case 'start':
        result = timerService.startTimer(roomId, 'main', io);
        break;

      case 'pause':
        result = timerService.pauseTimer(roomId, 'main', io);
        break;

      case 'stop':
        result = timerService.stopTimer(roomId, 'main', io);
        break;

      case 'adjust':
        if (typeof amount !== 'number') {
          roomLogger.warn('Invalid adjustment amount', { roomId, amount, socketId: socket.id });
          return socket.emit('error', 'Invalid adjustment amount');
        }
        result = timerService.adjustTimer(roomId, amount, 'main', io);
        break;

      case 'reset':
        result = timerService.resetTimer(roomId, amount, 'main', io);
        break;

      default:
        roomLogger.warn('Unknown timer action', { roomId, action, socketId: socket.id });
        return socket.emit('error', 'Unknown timer action');
    }

    if (!result) {
      roomLogger.error('Timer control operation failed', { roomId, action, socketId: socket.id });
      socket.emit('error', 'Timer operation failed');
    }
  });

  // Secondary timer control handler
  socket.on('secondary_timer_control', ({ roomId, action, amount }) => {
    roomLogger.debug('Secondary timer control received', { roomId, action, amount, socketId: socket.id });

    if (!roomId || !action) {
      roomLogger.warn('Invalid secondary timer control parameters', { roomId, action, socketId: socket.id });
      return socket.emit('error', 'Invalid secondary timer control parameters');
    }

    const timer = timerService.getTimerState(roomId, 'secondary');
    if (!timer) {
      roomLogger.warn('No secondary timer found for room', { roomId, socketId: socket.id });
      return socket.emit('error', 'Secondary timer not found for room');
    }

    let result = false;

    switch (action) {
      case 'start':
        result = timerService.startTimer(roomId, 'secondary', io);
        break;

      case 'pause':
        result = timerService.pauseTimer(roomId, 'secondary', io);
        break;

      case 'stop':
        result = timerService.stopTimer(roomId, 'secondary', io);
        break;

      case 'adjust':
        if (typeof amount !== 'number') {
          roomLogger.warn('Invalid secondary timer adjustment amount', { roomId, amount, socketId: socket.id });
          return socket.emit('error', 'Invalid adjustment amount');
        }
        result = timerService.adjustTimer(roomId, amount, 'secondary', io);
        break;

      case 'reset':
        result = timerService.resetTimer(roomId, amount, 'secondary', io);
        break;

      default:
        roomLogger.warn('Unknown secondary timer action', { roomId, action, socketId: socket.id });
        return socket.emit('error', 'Unknown secondary timer action');
    }

    if (!result) {
      roomLogger.error('Secondary timer control operation failed', { roomId, action, socketId: socket.id });
      socket.emit('error', 'Secondary timer operation failed');
    }
  });
}

module.exports = { setupTimerHandlers };