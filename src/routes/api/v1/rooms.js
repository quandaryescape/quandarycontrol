const express = require('express');
const { nanoid } = require('nanoid');
const path = require('path');
const fs = require('fs');
const { logger } = require('../../../../utils/logger');
const { getDatabase } = require('../../../../db/database');
const {
  validateRequest,
  validateRoomId,
  validateShortcode,
  sanitizeHtmlContent
} = require('../../../middleware/validation');

const router = express.Router();
const roomLogger = logger.child({ module: 'api-rooms' });

/**
 * Generate a unique shortcode for room access
 */
function generateShortcode(db) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let shortcode;
  let attempts = 0;

  do {
    // Start with 4 chars, increase if conflicts
    const length = 4 + Math.floor(attempts / 26);
    shortcode = '';
    for (let i = 0; i < length; i++) {
      shortcode += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Check if shortcode exists
    const existing = db.prepare('SELECT id FROM rooms WHERE shortcode = ?').get(shortcode);
    if (!existing) {
      roomLogger.debug('Shortcode generated', { shortcode, attempts });
      return shortcode;
    }

    attempts++;
  } while (attempts < 100); // Prevent infinite loop

  roomLogger.error('Failed to generate unique shortcode after 100 attempts');
  throw new Error('Failed to generate unique shortcode');
}

/**
 * Get room by shortcode
 */
function getRoomByShortcode(db, shortcode) {
  const stmt = db.prepare('SELECT * FROM rooms WHERE shortcode = ?');
  const result = stmt.get(shortcode);
  return result;
}

/**
 * Get all rooms
 */
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all();

    roomLogger.info('Rooms list retrieved', {
      count: rooms.length,
      ip: req.ip
    });

    res.json({ success: true, data: rooms.map(require('../../../services/room-privacy').publicRoomRow) });
  } catch (error) {
    roomLogger.error('Error retrieving rooms', {
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a specific room by ID
 */
router.get('/:id', validateRoomId, (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);

    if (!room) {
      roomLogger.warn('Room not found', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    roomLogger.info('Room retrieved', { roomId: id, roomName: room.name, ip: req.ip });
    res.json({ success: true, data: require('../../../services/room-privacy').publicRoomRow(room) });
  } catch (error) {
    roomLogger.error('Error retrieving room', {
      roomId: req.params.id,
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a room by shortcode
 */
router.get('/shortcode/:shortcode', (req, res) => {
  try {
    const { shortcode } = req.params;
    const db = getDatabase();
    const room = getRoomByShortcode(db, shortcode.toUpperCase());

    if (!room) {
      roomLogger.warn('Room not found by shortcode', { shortcode, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    roomLogger.info('Room retrieved by shortcode', {
      shortcode,
      roomId: room.id,
      roomName: room.name,
      ip: req.ip
    });
    res.json({ success: true, data: require('../../../services/room-privacy').publicRoomRow(room) });
  } catch (error) {
    roomLogger.error('Error retrieving room by shortcode', {
      shortcode: req.params.shortcode,
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create a new room
 */
router.post('/', validateRequest('room'), sanitizeHtmlContent, (req, res) => {
  try {
    const {
      name,
      config = {},
      timer_duration = 0,
      secondary_timer_enabled = false,
      secondary_timer_duration = 0,
      api_variables = {},
      hint_config = {},
      theme = 'example-theme'
    } = req.body;

    if (!name) {
      roomLogger.warn('Room creation failed - name required', { ip: req.ip });
      return res.status(400).json({ success: false, error: 'Room name is required' });
    }

    // Validate theme exists
    const themePath = path.join(__dirname, '../../../../themes', theme, 'index.html');
    if (!fs.existsSync(themePath)) {
      roomLogger.warn('Room creation failed - theme not found', { theme, ip: req.ip });
      return res.status(400).json({ success: false, error: `Theme '${theme}' not found` });
    }

    const db = getDatabase();
    const roomId = nanoid();
    const shortcode = generateShortcode(db);

    // Update config to include theme
    const roomConfig = { ...config, theme };

    const insertStmt = db.prepare(`
      INSERT INTO rooms (id, shortcode, name, config, timer_duration, secondary_timer_enabled, secondary_timer_duration, api_variables, hint_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      roomId,
      shortcode,
      name,
      JSON.stringify(roomConfig),
      timer_duration,
      secondary_timer_enabled ? 1 : 0,
      secondary_timer_duration,
      JSON.stringify(api_variables),
      JSON.stringify(hint_config || {})
    );

    const newRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);

    roomLogger.info('Room created successfully', {
      roomId,
      roomName: name,
      shortcode,
      theme,
      ip: req.ip
    });

    res.status(201).json({ success: true, data: newRoom });
  } catch (error) {
    roomLogger.error('Error creating room', {
      roomName: req.body.name,
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update a room
 */
router.put('/:id', validateRoomId, validateRequest('room'), sanitizeHtmlContent, (req, res) => {
  try {
    const { id } = req.params;
    const { name, config, timer_duration, secondary_timer_enabled, secondary_timer_duration, api_variables, hint_config } = req.body;

    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);

    if (!room) {
      roomLogger.warn('Room update failed - room not found', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    const updateFields = [];
    const updateValues = [];

    if (name !== undefined) {
      updateFields.push('name = ?');
      updateValues.push(name);
    }
    if (config !== undefined) {
      updateFields.push('config = ?');
      updateValues.push(JSON.stringify(config));
    }
    if (timer_duration !== undefined) {
      updateFields.push('timer_duration = ?');
      updateValues.push(timer_duration);
    }
    if (secondary_timer_enabled !== undefined) {
      updateFields.push('secondary_timer_enabled = ?');
      updateValues.push(secondary_timer_enabled);
    }
    if (secondary_timer_duration !== undefined) {
      updateFields.push('secondary_timer_duration = ?');
      updateValues.push(secondary_timer_duration);
    }
    if (api_variables !== undefined) {
      updateFields.push('api_variables = ?');
      updateValues.push(JSON.stringify(api_variables));
    }
    if (hint_config !== undefined) {
      updateFields.push('hint_config = ?');
      updateValues.push(JSON.stringify(hint_config || {}));
    }

    if (updateFields.length === 0) {
      roomLogger.warn('Room update failed - no fields to update', { roomId: id, ip: req.ip });
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    updateValues.push(id);

    const updateStmt = db.prepare(`
      UPDATE rooms
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `);

    const result = updateStmt.run(...updateValues);

    if (result.changes === 0) {
      roomLogger.warn('Room update failed - no changes made', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    const updatedRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);

    roomLogger.info('Room updated successfully', {
      roomId: id,
      fieldsUpdated: updateFields.length,
      ip: req.ip
    });

    res.json({ success: true, data: updatedRoom });
  } catch (error) {
    roomLogger.error('Error updating room', {
      roomId: req.params.id,
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a room
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      roomLogger.warn('Room deletion failed - room not found', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    const deleteStmt = db.prepare('DELETE FROM rooms WHERE id = ?');
    const result = deleteStmt.run(id);

    if (result.changes === 0) {
      roomLogger.warn('Room deletion failed - no changes made', { roomId: id, ip: req.ip });
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    roomLogger.info('Room deleted successfully', {
      roomId: id,
      roomName: room.name,
      ip: req.ip
    });

    res.json({ success: true, message: 'Room deleted successfully' });
  } catch (error) {
    roomLogger.error('Error deleting room', {
      roomId: req.params.id,
      error: error.message,
      ip: req.ip
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;