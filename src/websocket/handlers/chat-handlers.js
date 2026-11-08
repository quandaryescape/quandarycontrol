const { logger } = require('../../../utils/logger');

const chatLogger = logger.child({ module: 'chat-websocket' });

/**
 * Chat and hint handlers for WebSocket connections
 */
function setupChatHandlers(socket, io, services = {}) {
  const engine = services.automationEngine;
  const idle = services.idleClear;

  function broadcastHint(roomId, message) {
    const hintData = {
      message,
      timestamp: new Date().toISOString(),
      source: 'gm'
    };
    io.to(roomId).emit('hintReceived', hintData);
    // Legacy event for older themes
    io.to(roomId).emit('receive_hint', message);
    socket.emit('hintConfirmed', message);
    if (idle) idle.touch(roomId, { hints: true });
    if (engine) engine.onRoomEvent(roomId, 'hint_sent', { message }).catch(() => {});
  }

  // Legacy hint broadcast (keeping for backward compatibility)
  socket.on('send_hint', ({ roomId, hint } = {}) => {
    if (!roomId || typeof hint !== 'string' || hint.trim().length === 0 || hint.length > 1000) {
      return socket.emit('error', 'Invalid hint format');
    }
    broadcastHint(roomId, hint.trim());
  });

  // GM hint broadcast (preferred)
  socket.on('sendHint', ({ roomId, message } = {}) => {
    if (!roomId || typeof message !== 'string' || message.trim().length === 0 || message.length > 1000) {
      chatLogger.warn('Invalid hint format', { roomId, messageLength: message?.length, socketId: socket.id });
      return socket.emit('error', 'Invalid hint format');
    }
    chatLogger.info('Hint sent', { roomId, messageLength: message.length });
    broadcastHint(roomId, message.trim());
  });

  // Two-way chat between GM and Player
  socket.on('chat_message', ({ roomId, sender, message, timestamp } = {}) => {
    if (!roomId || typeof message !== 'string' || message.trim() === '') {
      return socket.emit('error', 'Invalid chat message');
    }

    const safeSender = ['gm', 'player'].includes(sender) ? sender : 'unknown';
    const sanitizedMessage = message.slice(0, 1000).trim();
    const payload = {
      sender: safeSender,
      message: sanitizedMessage,
      timestamp: timestamp || new Date().toISOString()
    };

    io.to(roomId).emit('chat_message', payload);
    if (idle) idle.touch(roomId, { chat: true });

    if (engine) {
      const eventName = safeSender === 'player' ? 'player_message' : 'gm_message';
      engine.onRoomEvent(roomId, eventName, { message: sanitizedMessage }).catch(() => {});
    }
  });

  // Player typing indicator (GM side shows "Players are typing…")
  socket.on('typing', ({ roomId, sender } = {}) => {
    if (!roomId) return;
    socket.to(roomId).emit('typing', { sender: sender === 'gm' ? 'gm' : 'player' });
  });

  socket.on('clear_chat', ({ roomId } = {}) => {
    if (!roomId) return socket.emit('error', 'Invalid room ID');
    io.to(roomId).emit('clear_chat');
    if (idle) idle.cleared(roomId, { chat: true });
  });

  socket.on('clear_hints', ({ roomId } = {}) => {
    if (!roomId) return socket.emit('error', 'Invalid room ID');
    io.to(roomId).emit('clear_hints');
    if (idle) idle.cleared(roomId, { hints: true });
  });

  // Lightbox media display handler (supports text-only + autoclose settings)
  socket.on('show_lightbox', ({ roomId, mediaId, url, headline, autoCloseEnabled = true, autoCloseSeconds = 5 } = {}) => {
    if (!roomId) return socket.emit('error', 'Invalid lightbox parameters');
    if (idle) idle.touch(roomId, { overlays: true });
    io.to(roomId).emit('show_lightbox', {
      mediaId: mediaId || null,
      url: url || null,
      headline: headline || '',
      autoCloseEnabled,
      autoCloseSeconds
    });
  });
}

module.exports = { setupChatHandlers };
