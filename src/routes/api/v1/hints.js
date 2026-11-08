const express = require('express');
const { logger } = require('../../../../utils/logger');
const { getDatabase } = require('../../../../db/database');

const router = express.Router();
const hintLogger = logger.child({ module: 'api-hints' });

/**
 * Get hints configuration for a room
 */
router.get('/rooms/:id/hints', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      hintLogger.warn('Hints config request for non-existent room', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    let hints = {};
    try {
      hints = JSON.parse(room.hint_config || '{}');
    } catch (e) {
      hintLogger.warn('Invalid JSON in hint_config', {
        roomId: id,
        error: e.message,
        ip: req.ip
      });
      hints = {};
    }

    hintLogger.info('Hints configuration retrieved', {
      roomId: id,
      hasConfig: Object.keys(hints).length > 0,
      ip: req.ip
    });

    res.json({ success: true, data: require('../../../services/room-privacy').publicHints(hints) });
  } catch (error) {
    hintLogger.error('Error retrieving hints configuration', {
      roomId: req.params.id,
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update hints configuration for a room
 */
router.put('/rooms/:id/hints', (req, res) => {
  try {
    const { id } = req.params;
    const { hints } = req.body;

    if (hints !== null && typeof hints !== 'object') {
      hintLogger.warn('Hints update failed - invalid hints format', {
        roomId: id,
        hintsType: typeof hints,
        ip: req.ip
      });
      return res.status(400).json({
        success: false,
        error: 'Hints configuration must be an object or null'
      });
    }

    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      hintLogger.warn('Hints update failed - room not found', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    const hintConfig = hints || {};
    const updateStmt = db.prepare('UPDATE rooms SET hint_config = ? WHERE id = ?');
    const result = updateStmt.run(JSON.stringify(hintConfig), id);

    if (result.changes === 0) {
      hintLogger.warn('Hints update failed - no changes made', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    hintLogger.info('Hints configuration updated', {
      roomId: id,
      configKeys: Object.keys(hintConfig).length,
      ip: req.ip
    });

    res.json({ success: true, data: hintConfig });
  } catch (error) {
    hintLogger.error('Error updating hints configuration', {
      roomId: req.params.id,
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;