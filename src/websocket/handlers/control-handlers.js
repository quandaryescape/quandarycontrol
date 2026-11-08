const { logger } = require('../../../utils/logger');

const controlLogger = logger.child({ module: 'control-websocket' });

/**
 * GM control-surface events: manual automations, variable edits, overlays,
 * slideshows on player screens.
 */
function setupControlHandlers(socket, io, services = {}) {
  const { automationEngine, variableService, idleClear } = services;

  function isGm(roomId) {
    return socket.clientType === 'gm' && socket.roomId === roomId;
  }

  socket.on('run_automation', async ({ roomId, automationId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!automationEngine || !roomId || !automationId) return reply({ success: false, error: 'Invalid request' });
    if (!isGm(roomId) && socket.adminRoomId !== roomId) return reply({ success: false, error: 'Not authorized for this room' });
    try {
      const run = automationEngine.runManual(roomId, automationId);
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000).unref());
      const result = await Promise.race([run, timeout]);
      if (!result) run.catch(() => {});
      reply({ success: true, data: result || { ran: true, pending: true } });
    } catch (error) {
      controlLogger.warn('Manual automation failed', { roomId, automationId, error: error.message });
      reply({ success: false, error: error.message });
    }
  });

  socket.on('set_variable', ({ roomId, name, value, type, mode } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!variableService || !roomId || !name) return reply({ success: false, error: 'Invalid request' });
    if (!isGm(roomId) && socket.adminRoomId !== roomId) return reply({ success: false, error: 'Not authorized for this room' });
    try {
      const res = mode && mode !== 'set'
        ? variableService.modifyVariable(roomId, name, mode, value, { source: 'gm' })
        : variableService.setVariable(roomId, name, value, { type: type || 'auto', source: 'gm' });
      reply({ success: true, data: res });
    } catch (error) {
      reply({ success: false, error: error.message });
    }
  });

  socket.on('show_message', ({ roomId, text, title, duration = 6, style = 'info' } = {}) => {
    if (!roomId || !isGm(roomId) || typeof text !== 'string' || !text.trim()) return;
    if (idleClear) idleClear.touch(roomId, { overlays: true });
    io.to(roomId).emit('show_message', { text: text.slice(0, 2000), title: String(title || '').slice(0, 200), duration: Number(duration) || 0, style });
  });

  socket.on('close_overlays', ({ roomId } = {}) => {
    if (!roomId || !isGm(roomId)) return;
    io.to(roomId).emit('close_overlays');
    if (idleClear) idleClear.cleared(roomId, { overlays: true });
  });

  socket.on('start_slideshow', ({ roomId, slideshowId } = {}) => {
    if (!roomId || !isGm(roomId)) return;
    io.to(roomId).emit('start_slideshow', { slideshowId: slideshowId || null });
  });

  socket.on('reload_players', ({ roomId } = {}) => {
    if (!roomId || !isGm(roomId)) return;
    io.to(roomId).emit('reload_player');
  });

  socket.on('play_sound', ({ roomId, url, volume = 70 } = {}) => {
    if (!roomId || !isGm(roomId) || !url) return;
    io.to(roomId).emit('play_sound', { url, file: url, volume, playerOnly: true });
  });
}

module.exports = { setupControlHandlers };
