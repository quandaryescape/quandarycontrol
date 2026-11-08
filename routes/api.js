const express = require('express');
const { nanoid } = require('nanoid');
const { getDatabase } = require('../db/database');

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { getServices } = require('../src/services/registry');
const { publicRoomRow, publicHints } = require('../src/services/room-privacy');
const { createUpload } = require('../src/routes/upload');

/**
 * Legacy trigger entry point, kept for older callers. Variable changes now go
 * through VariableService, which runs automations itself.
 */
function checkAndExecuteTriggers(roomId, variableName, newValue) {
  const services = getServices();
  if (!services) return;
  return services.automationEngine.handleEvent(roomId, { type: 'variable', name: variableName, value: newValue, previous: undefined });
}

function getIo(req) {
  return (req && req.app && req.app.get('io')) || (getServices() && getServices().io) || null;
}

const upload = createUpload();

const router = express.Router();

// Generate unique shortcode (4-6 characters)
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
    attempts++;
  } while (attempts < 1000 && findRoomByShortcode(db, shortcode)); // Check uniqueness

  if (attempts >= 1000) {
    throw new Error('Unable to generate unique shortcode');
  }

  return shortcode;
}

// Helper function to find room by shortcode
function findRoomByShortcode(db, shortcode) {
  const stmt = db.prepare('SELECT id FROM rooms WHERE shortcode = ?');
  const result = stmt.get(shortcode);
  return result;
}

// Helper function to find room by shortcode (export for use)
function getRoomByShortcode(db, shortcode) {
  const stmt = db.prepare('SELECT * FROM rooms WHERE shortcode = ?');
  const result = stmt.get(shortcode);
  return result;
}

/**
 * Get all rooms
 */
router.get('/rooms', (req, res) => {
  try {
    const db = getDatabase();
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all();
    res.json({ success: true, data: rooms.map(publicRoomRow) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a specific room by ID
 */
router.get('/rooms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);

    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    res.json({ success: true, data: publicRoomRow(room) });
  } catch (error) {
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
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    res.json({ success: true, data: publicRoomRow(room) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create a new room
 */
router.post('/rooms', (req, res) => {
  try {
    const { name, config = {}, timer_duration = 0, secondary_timer_enabled = false, secondary_timer_duration = 0, api_variables = {}, hint_config = {}, theme = 'boilerplate' } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'Room name is required' });
    }

    // Validate theme exists
    const themePath = path.join(__dirname, '..', 'themes', theme, 'index.html');
    if (!fs.existsSync(themePath)) {
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
      secondary_timer_enabled,
      secondary_timer_duration,
      JSON.stringify(api_variables),
      JSON.stringify(hint_config || {})
    );

    const newRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    res.status(201).json({ success: true, data: newRoom });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update a room
 */
router.put('/rooms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, config, timer_duration, secondary_timer_enabled, secondary_timer_duration, api_variables, hint_config } = req.body;
    
    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    
    if (!room) {
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
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    const updatedRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    res.json({ success: true, data: updatedRoom });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a room
 */
router.delete('/rooms/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    const deleteStmt = db.prepare('DELETE FROM rooms WHERE id = ?');
    const result = deleteStmt.run(id);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    res.json({ success: true, message: 'Room deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get variables for a room (user variables + live timer variables)
 */
router.get('/rooms/:id/variables', (req, res) => {
  const { variableService } = getServices();
  const vars = variableService.getAllVariables(req.params.id);
  if (vars === null) return res.status(404).json({ success: false, error: 'Room not found' });
  res.json({ success: true, data: variableService.toLegacyArray(req.params.id, vars) });
});

/**
 * Add or update a variable in a room
 */
router.post('/rooms/:id/variables', (req, res) => {
  const { name, type = 'auto', value } = req.body || {};
  if (!name || value === undefined) {
    return res.status(400).json({ success: false, error: 'Name and value are required' });
  }
  try {
    const { variableService } = getServices();
    const result = variableService.setVariable(req.params.id, name, value, { type, source: 'api' });
    res.status(201).json({
      success: true,
      data: { id: Date.now(), room_id: req.params.id, name, type, value: String(value), parsed_value: result.value }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * Update a specific variable in a room via URL parameters (hardware friendly)
 */
router.post('/rooms/:roomId/variables/:varName', (req, res) => {
  const body = req.body || {};
  const value = body.value !== undefined ? body.value : req.query.value;
  if (value === undefined) {
    return res.status(400).json({ success: false, error: 'Value is required in request body' });
  }
  try {
    const { variableService } = getServices();
    const result = variableService.setVariable(req.params.roomId, req.params.varName, value, {
      type: body.type || req.query.type || 'auto',
      source: 'api'
    });
    res.status(201).json({ success: true, data: { [result.name]: result.value } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

/**
 * Get rules for a room
 */
router.get('/rooms/:id/rules', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    // Fetch all media and filter to metadata.category === 'rules'
    const rows = db.prepare(`
      SELECT * FROM room_media
      WHERE room_id = ?
      ORDER BY order_index ASC, created_at ASC
    `).all(id);

    const rules = rows.filter(r => {
      try {
        const m = JSON.parse(r.metadata || '{}');
        return m.category === 'rules';
      } catch (_) { return false; }
    });

    const data = rules.map(rule => ({
      ...rule,
      metadata: JSON.parse(rule.metadata || '{}')
    }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Upload rules media for a room
 */
router.post('/rooms/:id/rules', upload.single('media'), (req, res) => {
  try {
    const { id } = req.params;

    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    // Multipart upload path (file sent as "media")
    if (req.file) {
      const { filename, mimetype, originalname = '', size = 0 } = req.file;

      // Map to existing CHECK(type IN ('image','video','audio','other'))
      let assetType = 'other';
      if (mimetype && typeof mimetype === 'string') {
        if (mimetype.startsWith('image/')) assetType = 'image';
        else if (mimetype.startsWith('video/')) assetType = 'video';
        else if (mimetype.startsWith('audio/')) assetType = 'audio';
      }

      // Compute next order_index among only "rules" category items
      const allRows = db.prepare('SELECT id, metadata, order_index FROM room_media WHERE room_id = ?').all(id);
      let maxIdx = -1;
      for (const r of allRows) {
        try {
          const m = JSON.parse(r.metadata || '{}');
          if (m.category === 'rules' && typeof r.order_index === 'number') {
            if (r.order_index > maxIdx) maxIdx = r.order_index;
          }
        } catch (_) {}
      }
      const indexToUse = maxIdx + 1;

      const mediaId = nanoid();
      const url = `/uploads/${filename}`;
      const title = (req.body && req.body.title) ? req.body.title : (originalname || '');
      const thumbnail_url = '';
      const meta = {
        originalname,
        mimetype,
        size,
        uploaded_at: new Date().toISOString(),
        category: 'rules'
      };

      db.prepare(`
        INSERT INTO room_media (id, room_id, type, title, url, thumbnail_url, metadata, order_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mediaId,
        id,
        assetType,
        title,
        url,
        thumbnail_url,
        JSON.stringify(meta),
        indexToUse
      );

      const created = db.prepare('SELECT * FROM room_media WHERE id = ?').get(mediaId);
      const data = {
        ...created,
        metadata: JSON.parse(created.metadata || '{}')
      };
      
      return res.status(201).json({ success: true, data });
    }

    return res.status(400).json({ success: false, error: 'No file uploaded' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a rule
 */
router.delete('/rooms/:id/rules/:ruleId', (req, res) => {
  try {
    const { id, ruleId } = req.params;
    const db = getDatabase();

    const existing = db.prepare('SELECT * FROM room_media WHERE id = ? AND room_id = ?').get(ruleId, id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }
    // Ensure this media item is a "rules" item
    let metaOk = false;
    try {
      const m = JSON.parse(existing.metadata || '{}');
      metaOk = m.category === 'rules';
    } catch (_) { metaOk = false; }
    if (!metaOk) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }

    const result = db.prepare('DELETE FROM room_media WHERE id = ? AND room_id = ?').run(ruleId, id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Rule not found' });
    }

    res.json({ success: true, message: 'Rule deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update rules order
 */
router.post('/rooms/:id/rules/order', (req, res) => {
  try {
    const { id } = req.params;
    const { ruleIds } = req.body;

    if (!Array.isArray(ruleIds)) {
      return res.status(400).json({ success: false, error: 'ruleIds must be an array' });
    }

    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    // Verify all rule IDs belong to this room and are category 'rules'
    if (ruleIds.length > 0) {
      const placeholders = ruleIds.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, metadata FROM room_media WHERE room_id = ? AND id IN (${placeholders})`).all(id, ...ruleIds);
      if (rows.length !== ruleIds.length) {
        return res.status(400).json({ success: false, error: 'One or more items do not belong to the room' });
      }
      const allRules = rows.every(r => {
        try { return JSON.parse(r.metadata || '{}').category === 'rules'; } catch (_) { return false; }
      });
      if (!allRules) {
        return res.status(400).json({ success: false, error: 'One or more items are not rules media' });
      }
    }

    // Update order for each rule
    const tx = db.transaction((updates) => {
      const stmt = db.prepare('UPDATE room_media SET order_index = ? WHERE id = ?');
      updates.forEach((ruleId, index) => {
        stmt.run(index, ruleId);
      });
    });
    tx(ruleIds);

    // Return updated rules list
    const rowsAll = db.prepare(`
      SELECT * FROM room_media
      WHERE room_id = ?
      ORDER BY order_index ASC, created_at ASC
    `).all(id);

    const rules = rowsAll.filter(r => {
      try { return JSON.parse(r.metadata || '{}').category === 'rules'; } catch (_) { return false; }
    });

    const data = rules.map(rule => ({
      ...rule,
      metadata: JSON.parse(rule.metadata || '{}')
    }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get hints configuration for a room
 */
router.get('/rooms/:id/hints', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    let hints = {};
    try {
      hints = JSON.parse(room.hint_config || '{}');
    } catch (e) {
      console.warn(`Invalid JSON in hint_config for room ${id}:`, e);
      hints = {};
    }

    res.json({ success: true, data: publicHints(hints) });
  } catch (error) {
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
      return res.status(400).json({
        success: false,
        error: 'Hints configuration must be an object or null'
      });
    }

    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    const updateStmt = db.prepare('UPDATE rooms SET hint_config = ? WHERE id = ?');
    updateStmt.run(JSON.stringify(hints || {}), id);

    res.json({ success: true, data: hints || {} });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get timer configuration for a room
 */
router.get('/rooms/:id/timer', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    const timerConfig = {
      duration: room.timer_duration,
      // Could be extended with additional JSON-based timer config if needed
    };

    res.json({ success: true, data: timerConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update timer configuration for a room
 */
router.put('/rooms/:id/timer', (req, res) => {
  try {
    const { id } = req.params;
    const { duration } = req.body;

    if (duration === undefined || duration < 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid timer duration is required'
      });
    }

    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    const updateStmt = db.prepare('UPDATE rooms SET timer_duration = ? WHERE id = ?');
    updateStmt.run(duration, id);

    const timerConfig = {
      duration: duration
    };

    res.json({ success: true, data: timerConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Media Storage + Lightbox API (for player lightbox feature)
 * - Tables: room_media, lightbox_sequences (see db/init.sql)
 * - Endpoints cover CRUD and reordering
 */

// Helpers (scoped to this router file)
function parseJsonSafe(str, fallback) {
  try { return JSON.parse(str || (typeof fallback === 'string' ? fallback : JSON.stringify(fallback || {}))); }
  catch (_) { return fallback; }
}
function isValidMediaType(t) {
  return ['image','video','audio','other'].includes(t);
}
function toMediaDTO(row) {
  return {
    ...row,
    metadata: parseJsonSafe(row.metadata, {})
  };
}
function toSequenceDTO(row) {
  return {
    ...row,
    items: parseJsonSafe(row.items, []),
    settings: parseJsonSafe(row.settings, {})
  };
}

/**
 * List media items for a room
 */
router.get('/rooms/:id/media', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

    const rows = db.prepare(`
      SELECT * FROM room_media
      WHERE room_id = ?
      ORDER BY order_index ASC, created_at ASC
    `).all(id);

    const data = rows.map(toMediaDTO);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create media item for a room
 * Body: { type: 'image'|'video'|'audio'|'other', title?, url, thumbnail_url?, metadata?, order_index? }
 */
// General upload endpoint for layout builder
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (req.file) {
      const filename = req.file.filename;
      const url = `/uploads/${filename}`;
      
      return res.json({
        success: true,
        url,
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        uploaded_at: new Date().toISOString()
      });
    }
    
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

router.post('/rooms/:id/media', upload.single('media'), (req, res) => {
  try {
    const { id } = req.params;

    const db = getDatabase();
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

    // Multipart upload path (file sent as "media")
    if (req.file) {
      const { filename, mimetype, originalname = '', size = 0 } = req.file;

      let derivedType = 'other';
      if (mimetype && typeof mimetype === 'string') {
        if (mimetype.startsWith('image/')) derivedType = 'image';
        else if (mimetype.startsWith('video/')) derivedType = 'video';
        else if (mimetype.startsWith('audio/')) derivedType = 'audio';
      }

      const indexRow = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS max_idx FROM room_media WHERE room_id = ?').get(id);
      const indexToUse = (indexRow?.max_idx ?? -1) + 1;

      const mediaId = nanoid();
      const url = `/uploads/${filename}`;
      const title = (req.body && req.body.title) ? req.body.title : (originalname || '');
      const thumbnail_url = '';
      const meta = {
        originalname,
        mimetype,
        size,
        uploaded_at: new Date().toISOString()
      };

      db.prepare(`
        INSERT INTO room_media (id, room_id, type, title, url, thumbnail_url, metadata, order_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mediaId,
        id,
        derivedType,
        title,
        url,
        thumbnail_url,
        JSON.stringify(meta),
        indexToUse
      );

      const created = db.prepare('SELECT * FROM room_media WHERE id = ?').get(mediaId);
      return res.status(201).json({ success: true, data: toMediaDTO(created) });
    }

    // JSON payload path (external URL added without file upload)
    const { type, title = '', url, thumbnail_url = '', metadata = {}, order_index } = req.body || {};

    if (!type || !isValidMediaType(type)) {
      return res.status(400).json({ success: false, error: 'Invalid or missing media type' });
    }
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'Media url is required' });
    }

    let indexToUse = order_index;
    if (indexToUse === undefined || indexToUse === null) {
      const row = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS max_idx FROM room_media WHERE room_id = ?').get(id);
      indexToUse = (row?.max_idx ?? -1) + 1;
    }

    const mediaId = nanoid();
    db.prepare(`
      INSERT INTO room_media (id, room_id, type, title, url, thumbnail_url, metadata, order_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mediaId,
      id,
      type,
      title,
      url,
      thumbnail_url,
      JSON.stringify(metadata || {}),
      indexToUse
    );

    const created = db.prepare('SELECT * FROM room_media WHERE id = ?').get(mediaId);
    res.status(201).json({ success: true, data: toMediaDTO(created) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update media item (by media id)
 * Body: any of { type, title, url, thumbnail_url, metadata, order_index }
 */
router.put('/media/:mediaId', (req, res) => {
  try {
    const { mediaId } = req.params;
    const { type, title, url, thumbnail_url, metadata, order_index } = req.body || {};

    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM room_media WHERE id = ?').get(mediaId);
    if (!existing) return res.status(404).json({ success: false, error: 'Media not found' });

    const fields = [];
    const values = [];

    if (type !== undefined) {
      if (!isValidMediaType(type)) {
        return res.status(400).json({ success: false, error: 'Invalid media type' });
      }
      fields.push('type = ?'); values.push(type);
    }
    if (title !== undefined) { fields.push('title = ?'); values.push(title); }
    if (url !== undefined) {
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'Invalid url' });
      }
      fields.push('url = ?'); values.push(url);
    }
    if (thumbnail_url !== undefined) { fields.push('thumbnail_url = ?'); values.push(thumbnail_url); }
    if (metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(metadata || {})); }
    if (order_index !== undefined) {
      if (typeof order_index !== 'number' || order_index < 0) {
        return res.status(400).json({ success: false, error: 'Invalid order_index' });
      }
      fields.push('order_index = ?'); values.push(order_index);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(mediaId);
    const result = db.prepare(`UPDATE room_media SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Media not found' });
    }

    const updated = db.prepare('SELECT * FROM room_media WHERE id = ?').get(mediaId);
    res.json({ success: true, data: toMediaDTO(updated) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update media title
 */
router.put('/media/:mediaId/title', (req, res) => {
  try {
    const { mediaId } = req.params;
    const { title } = req.body;
    const db = getDatabase();

    // Check if media exists
    const existing = db.prepare('SELECT id FROM room_media WHERE id = ?').get(mediaId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Media not found' });
    }

    // Update the title
    const result = db.prepare('UPDATE room_media SET title = ? WHERE id = ?').run(title, mediaId);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Media not found' });
    }

    res.json({ success: true, message: 'Media title updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete media item
 */
router.delete('/media/:mediaId', (req, res) => {
  try {
    const { mediaId } = req.params;
    const db = getDatabase();

    const existing = db.prepare('SELECT id FROM room_media WHERE id = ?').get(mediaId);
    if (!existing) return res.status(404).json({ success: false, error: 'Media not found' });

    const result = db.prepare('DELETE FROM room_media WHERE id = ?').run(mediaId);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Media not found' });
    }

    res.json({ success: true, message: 'Media deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
/**
 * Get a single media item by ID (for player lightbox)
 */
router.get('/media/:mediaId', (req, res) => {
  try {
    const { mediaId } = req.params;
    console.log('[API] GET /api/media/:mediaId', { mediaId });

    const db = getDatabase();
    const row = db.prepare('SELECT * FROM room_media WHERE id = ?').get(mediaId);

    if (!row) {
      console.warn('[API] Media not found', { mediaId });
      return res.status(404).json({ success: false, error: 'Media not found' });
    }

    console.log('[API] Media found', { mediaId, type: row.type, url: row.url });
    return res.json({ success: true, data: toMediaDTO(row) });
  } catch (error) {
    console.error('[API] Error fetching media', { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Reorder media items in a room
 * Body: { items: [{ id: string, order_index: number }, ...] }
 */
router.patch('/rooms/:id/media/reorder', (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array is required' });
    }

    const db = getDatabase();
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

    const ids = items.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM room_media WHERE room_id = ? AND id IN (${placeholders})`).get(id, ...ids);
    if ((countRow?.cnt || 0) !== ids.length) {
      return res.status(400).json({ success: false, error: 'One or more media items do not belong to the room' });
    }

    const tx = db.transaction((updates) => {
      const stmt = db.prepare('UPDATE room_media SET order_index = ? WHERE id = ?');
      updates.forEach(u => {
        if (typeof u.order_index !== 'number' || u.order_index < 0) {
          throw new Error('Invalid order_index in updates');
        }
        stmt.run(u.order_index, u.id);
      });
    });

    tx(items);

    const rows = db.prepare(`
      SELECT * FROM room_media
      WHERE room_id = ?
      ORDER BY order_index ASC, created_at ASC
    `).all(id);

    res.json({ success: true, data: rows.map(toMediaDTO) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * List lightbox sequences for a room
 */
router.get('/rooms/:id/lightbox', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

    const rows = db.prepare(`
      SELECT * FROM lightbox_sequences
      WHERE room_id = ?
      ORDER BY created_at ASC
    `).all(id);

    res.json({ success: true, data: rows.map(toSequenceDTO) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create a lightbox sequence for a room
 * Body: { name: string, items?: any[], settings?: object }
 */
router.post('/rooms/:id/lightbox', (req, res) => {
  try {
    const { id } = req.params;
    const { name, items = [], settings = {} } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'Sequence name is required' });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items must be an array' });
    }

    const db = getDatabase();
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });

    const seqId = nanoid();
    db.prepare(`
      INSERT INTO lightbox_sequences (id, room_id, name, items, settings)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      seqId,
      id,
      name,
      JSON.stringify(items),
      JSON.stringify(settings || {})
    );

    const created = db.prepare('SELECT * FROM lightbox_sequences WHERE id = ?').get(seqId);
    res.status(201).json({ success: true, data: toSequenceDTO(created) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a specific lightbox sequence
 */
router.get('/lightbox/:sequenceId', (req, res) => {
  try {
    const { sequenceId } = req.params;
    const db = getDatabase();

    const seq = db.prepare('SELECT * FROM lightbox_sequences WHERE id = ?').get(sequenceId);
    if (!seq) return res.status(404).json({ success: false, error: 'Lightbox sequence not found' });

    res.json({ success: true, data: toSequenceDTO(seq) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update a lightbox sequence
 * Body: any of { name, items, settings }
 */
router.put('/lightbox/:sequenceId', (req, res) => {
  try {
    const { sequenceId } = req.params;
    const { name, items, settings } = req.body || {};

    const db = getDatabase();
    const existing = db.prepare('SELECT * FROM lightbox_sequences WHERE id = ?').get(sequenceId);
    if (!existing) return res.status(404).json({ success: false, error: 'Lightbox sequence not found' });

    const fields = [];
    const values = [];

    if (name !== undefined) {
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ success: false, error: 'Invalid name' });
      }
      fields.push('name = ?'); values.push(name);
    }
    if (items !== undefined) {
      if (!Array.isArray(items)) {
        return res.status(400).json({ success: false, error: 'items must be an array' });
      }
      fields.push('items = ?'); values.push(JSON.stringify(items));
    }
    if (settings !== undefined) {
      if (settings !== null && typeof settings !== 'object') {
        return res.status(400).json({ success: false, error: 'settings must be an object or null' });
      }
      fields.push('settings = ?'); values.push(JSON.stringify(settings || {}));
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(sequenceId);
    db.prepare(`UPDATE lightbox_sequences SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM lightbox_sequences WHERE id = ?').get(sequenceId);
    res.json({ success: true, data: toSequenceDTO(updated) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a lightbox sequence
 */
router.delete('/lightbox/:sequenceId', (req, res) => {
  try {
    const { sequenceId } = req.params;
    const db = getDatabase();

    const existing = db.prepare('SELECT id FROM lightbox_sequences WHERE id = ?').get(sequenceId);
    if (!existing) return res.status(404).json({ success: false, error: 'Lightbox sequence not found' });

    const result = db.prepare('DELETE FROM lightbox_sequences WHERE id = ?').run(sequenceId);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Lightbox sequence not found' });
    }

    res.json({ success: true, message: 'Lightbox sequence deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Layout Configuration API Endpoints
 */

/**
 * Get layout configuration for a room
 */
router.get('/rooms/:id/layout', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    let layoutConfig = {};
    try {
      const config = JSON.parse(room.config || '{}');
      layoutConfig = config.layout || {};
    } catch (e) {
      console.warn(`Invalid JSON in config for room ${id}:`, e);
      layoutConfig = {};
    }

    res.json({ success: true, data: layoutConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update layout configuration for a room
 */
router.put('/rooms/:id/layout', (req, res) => {
  try {
    const { id } = req.params;
    const { layout } = req.body;

    if (!layout || typeof layout !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Layout configuration must be an object'
      });
    }

    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    // Parse current config and update layout
    let config = {};
    try {
      config = JSON.parse(room.config || '{}');
    } catch (e) {
      console.warn(`Invalid JSON in config for room ${id}:`, e);
      config = {};
    }

    config.layout = layout;

    const updateStmt = db.prepare('UPDATE rooms SET config = ? WHERE id = ?');
    updateStmt.run(JSON.stringify(config), id);

    // Broadcast layout update via Socket.IO if available
    try {
      const io = getIo(req);
      io.to(id).emit('layout_updated', {
        layout: layout,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.warn('Socket.IO not available for layout broadcast');
    }

    res.json({ success: true, data: layout });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Validate layout configuration against schema
 */
router.post('/layout/validate', (req, res) => {
  try {
    const { layout } = req.body;

    if (!layout) {
      return res.status(400).json({
        success: false,
        error: 'Layout configuration is required'
      });
    }

    // Basic validation - in a real implementation, this would use the layout validator
    const result = {
      valid: true,
      errors: []
    };

    // Check for required layouts object
    if (!layout.layouts || typeof layout.layouts !== 'object') {
      result.valid = false;
      result.errors.push('Layout configuration must contain a "layouts" object');
    }

    // Check for default layout
    if (layout.layouts && !layout.layouts.default) {
      result.valid = false;
      result.errors.push('Layout configuration must contain a "default" layout');
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get layout presets
 */
router.get('/layout/presets', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    // Load presets from layout-config.json
    const configPath = path.join(__dirname, '..', 'config', 'layout-config.json');
    
    if (!fs.existsSync(configPath)) {
      return res.json({ success: true, data: {} });
    }

    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    res.json({ success: true, data: config.presets || {} });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Layout Template API Endpoints
 */

/**
 * Get all layout templates
 */
router.get('/layout-templates', (req, res) => {
  try {
    const db = getDatabase();
    
    const templates = db.prepare('SELECT * FROM layout_templates ORDER BY is_system DESC, name ASC').all();
    
    // Parse layout JSON for each template
    const parsedTemplates = templates.map(template => ({
      ...template,
      layout: JSON.parse(template.layout || '{}')
    }));
    
    res.json({ success: true, data: parsedTemplates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a specific layout template
 */
router.get('/layout-templates/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    const template = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    
    // Parse layout JSON
    const parsedTemplate = {
      ...template,
      layout: JSON.parse(template.layout || '{}')
    };
    
    res.json({ success: true, data: parsedTemplate });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create a new layout template
 */
router.post('/layout-templates', (req, res) => {
  try {
    const { name, description, layout, is_system = false } = req.body;
    
    if (!name || !layout) {
      return res.status(400).json({
        success: false,
        error: 'Name and layout are required'
      });
    }
    
    if (typeof layout !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Layout must be an object'
      });
    }
    
    const db = getDatabase();
    const templateId = nanoid();
    
    const insertStmt = db.prepare(`
      INSERT INTO layout_templates (id, name, description, layout, is_system)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    insertStmt.run(
      templateId,
      name,
      description || '',
      JSON.stringify(layout),
      is_system ? 1 : 0
    );
    
    const newTemplate = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(templateId);
    
    // Parse layout JSON for response
    const parsedTemplate = {
      ...newTemplate,
      layout: JSON.parse(newTemplate.layout || '{}')
    };
    
    res.status(201).json({ success: true, data: parsedTemplate });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update a layout template
 */
router.put('/layout-templates/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, layout, is_system } = req.body;
    
    const db = getDatabase();
    const template = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    
    const updateFields = [];
    const updateValues = [];
    
    if (name !== undefined) {
      updateFields.push('name = ?');
      updateValues.push(name);
    }
    if (description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(description);
    }
    if (layout !== undefined) {
      if (typeof layout !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Layout must be an object'
        });
      }
      updateFields.push('layout = ?');
      updateValues.push(JSON.stringify(layout));
    }
    if (is_system !== undefined) {
      updateFields.push('is_system = ?');
      updateValues.push(is_system ? 1 : 0);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    
    updateValues.push(id);
    
    const updateStmt = db.prepare(`
      UPDATE layout_templates
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    
    const result = updateStmt.run(...updateValues);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    
    const updatedTemplate = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    
    // Parse layout JSON for response
    const parsedTemplate = {
      ...updatedTemplate,
      layout: JSON.parse(updatedTemplate.layout || '{}')
    };
    
    res.json({ success: true, data: parsedTemplate });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a layout template
 */
router.delete('/layout-templates/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    const template = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    
    // Don't allow deletion of system templates
    if (template.is_system) {
      return res.status(403).json({ success: false, error: 'Cannot delete system templates' });
    }
    
    const deleteStmt = db.prepare('DELETE FROM layout_templates WHERE id = ?');
    const result = deleteStmt.run(id);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    
    res.json({ success: true, message: 'Template deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Apply a template to a room
 */
router.post('/rooms/:roomId/apply-template/:templateId', (req, res) => {
  try {
    const { roomId, templateId } = req.params;
    const db = getDatabase();
    
    // Check if room exists
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    // Get template
    const template = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(templateId);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    
    // Parse room config
    let config = {};
    try {
      config = JSON.parse(room.config || '{}');
    } catch (e) {
      console.warn(`Invalid JSON in config for room ${roomId}:`, e);
      config = {};
    }
    
    // Parse template layout
    let layout = {};
    try {
      layout = JSON.parse(template.layout || '{}');
    } catch (e) {
      console.warn(`Invalid JSON in layout for template ${templateId}:`, e);
      return res.status(500).json({ success: false, error: 'Invalid template layout' });
    }
    
    // Update room config with template layout
    config.layout = layout;
    
    // Update room
    const updateStmt = db.prepare('UPDATE rooms SET config = ? WHERE id = ?');
    updateStmt.run(JSON.stringify(config), roomId);
    
    // Broadcast layout update via Socket.IO if available
    try {
      const io = getIo(req);
      io.to(roomId).emit('layout_updated', {
        layout: layout,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.warn('Socket.IO not available for layout broadcast');
    }
    
    res.json({
      success: true,
      data: {
        roomId,
        templateId,
        layout,
        message: 'Template applied successfully'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Theme API Endpoints
 */


/**
 * Get a specific theme
 */
router.get('/themes/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    const theme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    
    if (!theme) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    // Parse JSON fields
    const parsedTheme = {
      ...theme,
      layout: JSON.parse(theme.layout || '{}'),
      theme_meta: JSON.parse(theme.theme_meta || '{}')
    };
    
    // If this is a child theme, fetch parent theme data
    if (theme.parent_theme_id) {
      const parentTheme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(theme.parent_theme_id);
      if (parentTheme) {
        parsedTheme.parent = {
          ...parentTheme,
          layout: JSON.parse(parentTheme.layout || '{}'),
          theme_meta: JSON.parse(parentTheme.theme_meta || '{}')
        };
      }
    }
    
    // Get theme assets
    const assets = db.prepare('SELECT * FROM theme_assets WHERE theme_id = ? ORDER BY file_path ASC').all(id);
    parsedTheme.assets = assets;
    
    res.json({ success: true, data: parsedTheme });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create a new theme
 */
// OLD DATABASE-BASED ENDPOINT - COMMENTED OUT
/*
router.post('/themes', (req, res) => {
  try {
    const { name, description, layout, theme_meta = {}, is_system = false, parent_theme_id } = req.body;
    
    if (!name || !layout) {
      return res.status(400).json({
        success: false,
        error: 'Name and layout are required'
      });
    }
    
    if (typeof layout !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Layout must be an object'
      });
    }
    
    const db = getDatabase();
    const themeId = nanoid();
    
    // Validate parent theme if specified
    if (parent_theme_id) {
      const parentTheme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(parent_theme_id);
      if (!parentTheme) {
        return res.status(400).json({
          success: false,
          error: 'Parent theme not found'
        });
      }
    }
    
    const insertStmt = db.prepare(`
      INSERT INTO layout_templates (id, name, description, layout, theme_meta, is_system, is_child, parent_theme_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    insertStmt.run(
      themeId,
      name,
      description || '',
      JSON.stringify(layout),
      JSON.stringify(theme_meta || {}),
      is_system ? 1 : 0,
      parent_theme_id ? 1 : 0,
      parent_theme_id || null
    );
    
    const newTheme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(themeId);
    
    // Parse JSON fields for response
    const parsedTheme = {
      ...newTheme,
      layout: JSON.parse(newTheme.layout || '{}'),
      theme_meta: JSON.parse(newTheme.theme_meta || '{}')
    };
    
    res.status(201).json({ success: true, data: parsedTheme });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
*/

/**
 * Update a theme
 */
// OLD DATABASE-BASED ENDPOINT - COMMENTED OUT  
/*
router.put('/themes/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, layout, theme_meta, is_system, parent_theme_id } = req.body;
    
    const db = getDatabase();
    const theme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    
    if (!theme) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    const updateFields = [];
    const updateValues = [];
    
    if (name !== undefined) {
      updateFields.push('name = ?');
      updateValues.push(name);
    }
    if (description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(description);
    }
    if (layout !== undefined) {
      if (typeof layout !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Layout must be an object'
        });
      }
      updateFields.push('layout = ?');
      updateValues.push(JSON.stringify(layout));
    }
    if (theme_meta !== undefined) {
      updateFields.push('theme_meta = ?');
      updateValues.push(JSON.stringify(theme_meta || {}));
    }
    if (is_system !== undefined) {
      updateFields.push('is_system = ?');
      updateValues.push(is_system ? 1 : 0);
    }
    if (parent_theme_id !== undefined) {
      // Validate parent theme if specified
      if (parent_theme_id) {
        const parentTheme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(parent_theme_id);
        if (!parentTheme) {
          return res.status(400).json({
            success: false,
            error: 'Parent theme not found'
          });
        }
        // Check for circular reference
        if (parent_theme_id === id) {
          return res.status(400).json({
            success: false,
            error: 'Theme cannot be its own parent'
          });
        }
      }
      updateFields.push('parent_theme_id = ?');
      updateFields.push('is_child = ?');
      updateValues.push(parent_theme_id || null);
      updateValues.push(parent_theme_id ? 1 : 0);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    
    updateValues.push(id);
    
    const updateStmt = db.prepare(`
      UPDATE layout_templates
      SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    
    const result = updateStmt.run(...updateValues);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    const updatedTheme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    
    // Parse JSON fields for response
    const parsedTheme = {
      ...updatedTheme,
      layout: JSON.parse(updatedTheme.layout || '{}'),
      theme_meta: JSON.parse(updatedTheme.theme_meta || '{}')
    };
    
    res.json({ success: true, data: parsedTheme });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
*/

/**
 * Delete a theme
 */
router.delete('/themes/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    const theme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(id);
    if (!theme) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    // Don't allow deletion of system themes
    if (theme.is_system) {
      return res.status(403).json({ success: false, error: 'Cannot delete system themes' });
    }
    
    // Check if this theme is a parent to other themes
    const childThemes = db.prepare('SELECT COUNT(*) as count FROM layout_templates WHERE parent_theme_id = ?').get(id);
    if (childThemes.count > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete theme that has child themes'
      });
    }
    
    // Delete theme assets first
    db.prepare('DELETE FROM theme_assets WHERE theme_id = ?').run(id);
    
    // Delete theme
    const deleteStmt = db.prepare('DELETE FROM layout_templates WHERE id = ?');
    const result = deleteStmt.run(id);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    res.json({ success: true, message: 'Theme deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Apply a theme to a room
 */
router.post('/rooms/:roomId/theme', (req, res) => {
  try {
    const { roomId } = req.params;
    const { themeId } = req.body;
    
    if (!themeId) {
      return res.status(400).json({
        success: false,
        error: 'Theme ID is required'
      });
    }
    
    const db = getDatabase();
    
    // Check if room exists
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    // Get theme
    const theme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(themeId);
    if (!theme) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    // Parse room config
    let config = {};
    try {
      config = JSON.parse(room.config || '{}');
    } catch (e) {
      console.warn(`Invalid JSON in config for room ${roomId}:`, e);
      config = {};
    }
    
    // Parse theme layout
    let layout = {};
    try {
      layout = JSON.parse(theme.layout || '{}');
    } catch (e) {
      console.warn(`Invalid JSON in layout for theme ${themeId}:`, e);
      return res.status(500).json({ success: false, error: 'Invalid theme layout' });
    }
    
    // Update room config with theme layout and theme ID
    config.layout = layout;
    config.themeId = themeId;
    
    // Update room
    const updateStmt = db.prepare('UPDATE rooms SET config = ? WHERE id = ?');
    updateStmt.run(JSON.stringify(config), roomId);
    
    // Broadcast layout update via Socket.IO if available
    try {
      const io = getIo(req);
      io.to(roomId).emit('layout_updated', {
        layout: layout,
        themeId: themeId,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.warn('Socket.IO not available for layout broadcast');
    }
    
    res.json({
      success: true,
      data: {
        roomId,
        themeId,
        layout,
        message: 'Theme applied successfully'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get theme assets
 */
router.get('/themes/:themeId/assets', (req, res) => {
  try {
    const { themeId } = req.params;
    const db = getDatabase();
    
    // Verify theme exists
    const theme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(themeId);
    if (!theme) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    const assets = db.prepare('SELECT * FROM theme_assets WHERE theme_id = ? ORDER BY file_path ASC').all(themeId);
    
    res.json({ success: true, data: assets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Add or update theme asset
 */
router.put('/themes/:themeId/assets', (req, res) => {
  try {
    const { themeId } = req.params;
    const { file_path, content } = req.body;
    
    if (!file_path || content === undefined) {
      return res.status(400).json({
        success: false,
        error: 'File path and content are required'
      });
    }
    
    const db = getDatabase();
    
    // Verify theme exists
    const theme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(themeId);
    if (!theme) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    // Check if asset already exists
    const existingAsset = db.prepare('SELECT * FROM theme_assets WHERE theme_id = ? AND file_path = ?').get(themeId, file_path);
    
    if (existingAsset) {
      // Update existing asset
      const updateStmt = db.prepare('UPDATE theme_assets SET content = ? WHERE theme_id = ? AND file_path = ?');
      updateStmt.run(content, themeId, file_path);
    } else {
      // Create new asset
      const assetId = nanoid();
      const insertStmt = db.prepare('INSERT INTO theme_assets (id, theme_id, file_path, content) VALUES (?, ?, ?, ?)');
      insertStmt.run(assetId, themeId, file_path, content);
    }
    
    const asset = db.prepare('SELECT * FROM theme_assets WHERE theme_id = ? AND file_path = ?').get(themeId, file_path);
    
    res.json({ success: true, data: asset });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete theme asset
 */
router.delete('/themes/:themeId/assets/:filePath', (req, res) => {
  try {
    const { themeId, filePath } = req.params;
    const db = getDatabase();
    
    // Verify theme exists
    const theme = db.prepare('SELECT * FROM layout_templates WHERE id = ?').get(themeId);
    if (!theme) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    const result = db.prepare('DELETE FROM theme_assets WHERE theme_id = ? AND file_path = ?').run(themeId, filePath);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }
    
    res.json({ success: true, message: 'Asset deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get available themes
 */
router.get('/themes', (req, res) => {
  try {
    const themesDir = path.join(__dirname, '..', 'themes');
    const themes = [];
    
    if (!fs.existsSync(themesDir)) {
      return res.json({ success: true, data: [] });
    }
    
    const entries = fs.readdirSync(themesDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const themeName = entry.name;
        const configPath = path.join(themesDir, themeName, 'theme-config.json');
        const indexPath = path.join(themesDir, themeName, 'index.html');
        
        // Only include themes that have both config and index files
        if (fs.existsSync(configPath) && fs.existsSync(indexPath)) {
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            themes.push({
              name: themeName,
              displayName: config.name || themeName,
              description: config.description || '',
              version: config.version || '1.0.0',
              author: config.author || '',
              components: config.components || {}
            });
          } catch (error) {
            console.warn(`Failed to parse theme config for ${themeName}:`, error);
          }
        }
      }
    }
    
    res.json({ success: true, data: themes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update theme configuration
 */
router.put('/themes/:themeName', (req, res) => {
  try {
    const { themeName } = req.params;
    const themeData = req.body;
    
    // Validate theme name
    if (!themeName || !themeName.match(/^[a-zA-Z0-9-_]+$/)) {
      return res.status(400).json({ success: false, error: 'Invalid theme name' });
    }
    
    const themeDir = path.join(__dirname, '..', 'themes', themeName);
    const configPath = path.join(themeDir, 'theme-config.json');
    
    if (!fs.existsSync(themeDir)) {
      return res.status(404).json({ success: false, error: 'Theme not found' });
    }
    
    // Update the theme configuration
    themeData.updated_at = new Date().toISOString();
    
    fs.writeFileSync(configPath, JSON.stringify(themeData, null, 2));
    
    res.json({ success: true, data: themeData });
  } catch (error) {
    console.error('Error updating theme:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create new theme
 */
router.post('/themes', (req, res) => {
  try {
    const themeData = req.body;
    const themeName = themeData.name;
    
    // Validate theme name
    if (!themeName || !themeName.match(/^[a-zA-Z0-9-_]+$/)) {
      return res.status(400).json({ success: false, error: 'Invalid theme name' });
    }
    
    const themeDir = path.join(__dirname, '..', 'themes', themeName);
    
    // Check if theme already exists
    if (fs.existsSync(themeDir)) {
      return res.status(409).json({ success: false, error: 'Theme already exists' });
    }
    
    // Create theme directory
    fs.mkdirSync(themeDir, { recursive: true });
    
    // Set creation time
    themeData.created_at = new Date().toISOString();
    themeData.updated_at = themeData.created_at;
    
    // Write theme config
    const configPath = path.join(themeDir, 'theme-config.json');
    fs.writeFileSync(configPath, JSON.stringify(themeData, null, 2));
    
    // Create basic theme files if they don't exist
    const indexPath = path.join(themeDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      const basicHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${themeData.displayName || themeName}</title>
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div class="theme-container">
        <header class="theme-header">
            [room-info]
            [timer]
        </header>
        
        <main class="theme-main">
            <div class="left-panel">
                [hints]
                [variables]
            </div>
            <div class="right-panel">
                [chat]
                [game-state]
            </div>
        </main>
    </div>
    
    [media]
    
    <script src="/socket.io/socket.io.js"></script>
    <script src="/player.js"></script>
</body>
</html>`;
      fs.writeFileSync(indexPath, basicHTML);
    }
    
    const stylePath = path.join(themeDir, 'style.css');
    if (!fs.existsSync(stylePath)) {
      const basicCSS = `/* ${themeData.displayName || themeName} Theme Styles */

.theme-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
    font-family: 'Segoe UI', sans-serif;
}

.theme-header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 20px;
    border-radius: 8px;
    margin-bottom: 20px;
}

.theme-main {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
}

.left-panel, .right-panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

/* Component styling */
.timer-component,
.hints-component,
.variables-component,
.chat-component,
.game-state-component {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    padding: 20px;
}

@media (max-width: 768px) {
    .theme-main {
        grid-template-columns: 1fr;
    }
}`;
      fs.writeFileSync(stylePath, basicCSS);
    }
    
    // Create basic JavaScript file
    const scriptPath = path.join(themeDir, 'script.js');
    if (!fs.existsSync(scriptPath)) {
      const basicJS = `// ${themeData.displayName || themeName} Theme JavaScript

// Theme-specific JavaScript functionality
document.addEventListener('DOMContentLoaded', function() {
    console.log('${themeData.displayName || themeName} theme loaded');
    
    // Initialize theme-specific features
    initializeTheme();
});

function initializeTheme() {
    // Add custom theme functionality here
    
    // Example: Custom timer formatting
    const timerElements = document.querySelectorAll('.timer-component');
    timerElements.forEach(timer => {
        timer.classList.add('${themeName}-timer');
    });
    
    // Example: Custom chat styling
    const chatElements = document.querySelectorAll('.chat-component');
    chatElements.forEach(chat => {
        chat.classList.add('${themeName}-chat');
    });
    
    // Add any other theme-specific initialization here
}

// Export theme configuration if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        name: '${themeName}',
        version: '${themeData.version || '1.0.0'}',
        initialize: initializeTheme
    };
}`;
      fs.writeFileSync(scriptPath, basicJS);
    }
    
    res.json({ success: true, data: themeData });
  } catch (error) {
    console.error('Error creating theme:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Notification Audio API Endpoints
 */

/**
 * Upload notification audio file
 */
router.post('/rooms/:id/notifications/audio', upload.single('audio'), (req, res) => {
  try {
    const { id } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file uploaded' });
    }
    
    // Validate audio file type
    const { mimetype, originalname, filename, size } = req.file;
    if (!mimetype.startsWith('audio/')) {
      return res.status(400).json({ success: false, error: 'File must be an audio file' });
    }
    
    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    const audioId = nanoid();
    const filePath = `/uploads/${filename}`;
    
    db.prepare(`
      INSERT INTO notification_audio (id, room_id, filename, original_name, file_path, file_size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(audioId, id, filename, originalname, filePath, size, mimetype);
    
    const created = db.prepare('SELECT * FROM notification_audio WHERE id = ?').get(audioId);
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get notification audio files for a room
 */
router.get('/rooms/:id/notifications/audio', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    const audioFiles = db.prepare('SELECT * FROM notification_audio WHERE room_id = ? ORDER BY created_at ASC').all(id);
    res.json({ success: true, data: audioFiles });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete notification audio file
 */
router.delete('/rooms/:id/notifications/audio/:audioId', (req, res) => {
  try {
    const { id, audioId } = req.params;
    const db = getDatabase();
    
    const audio = db.prepare('SELECT * FROM notification_audio WHERE id = ? AND room_id = ?').get(audioId, id);
    if (!audio) {
      return res.status(404).json({ success: false, error: 'Audio file not found' });
    }
    
    // Delete from database
    const result = db.prepare('DELETE FROM notification_audio WHERE id = ?').run(audioId);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Audio file not found' });
    }
    
    // Optionally delete physical file (uncomment if needed)
    // const fs = require('fs');
    // try {
    //   fs.unlinkSync(path.join(__dirname, '..', 'public', audio.file_path));
    // } catch (err) {
    //   console.warn('Could not delete physical file:', err);
    // }
    
    res.json({ success: true, message: 'Audio file deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get notification settings for a room
 */
router.get('/rooms/:id/notifications/settings', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();
    
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    const settings = db.prepare(`
      SELECT ns.*, na.original_name, na.file_path 
      FROM notification_settings ns 
      LEFT JOIN notification_audio na ON ns.audio_id = na.id 
      WHERE ns.room_id = ? 
      ORDER BY ns.setting_type ASC
    `).all(id);
    
    // Parse settings JSON
    const parsedSettings = settings.map(setting => ({
      ...setting,
      settings: JSON.parse(setting.settings || '{}')
    }));
    
    res.json({ success: true, data: parsedSettings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update notification settings
 */
router.put('/rooms/:id/notifications/settings', (req, res) => {
  try {
    const { id } = req.params;
    const { settings } = req.body;
    
    console.log('Received notification settings update:', { id, settings });
    
    if (!Array.isArray(settings)) {
      return res.status(400).json({ success: false, error: 'Settings must be an array' });
    }
    
    const db = getDatabase();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    const transaction = db.transaction(() => {
      // Clear existing settings
      db.prepare('DELETE FROM notification_settings WHERE room_id = ?').run(id);
      
      // Insert new settings
      const insertStmt = db.prepare(`
        INSERT INTO notification_settings (id, room_id, setting_type, audio_id, enabled, settings)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      for (const setting of settings) {
        const settingId = nanoid();
        const cleanAudioId = setting.audio_id === '' ? null : setting.audio_id;
        const cleanEnabled = setting.enabled ? 1 : 0;
        const cleanSettings = JSON.stringify(setting.settings || {});
        
        console.log('Inserting setting:', {
          settingId,
          roomId: id,
          settingType: setting.setting_type,
          audioId: cleanAudioId,
          enabled: cleanEnabled,
          settings: cleanSettings
        });
        
        insertStmt.run(
          settingId,
          id,
          setting.setting_type,
          cleanAudioId,
          cleanEnabled,
          cleanSettings
        );
      }
    });
    
    transaction();
    
    // Return updated settings
    const updatedSettings = db.prepare(`
      SELECT ns.*, na.original_name, na.file_path 
      FROM notification_settings ns 
      LEFT JOIN notification_audio na ON ns.audio_id = na.id 
      WHERE ns.room_id = ? 
      ORDER BY ns.setting_type ASC
    `).all(id);
    
    const parsedSettings = updatedSettings.map(setting => ({
      ...setting,
      settings: JSON.parse(setting.settings || '{}')
    }));
    
    res.json({ success: true, data: parsedSettings });
  } catch (error) {
    console.error('Error updating notification settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GM Customization endpoints
router.get('/rooms/:id/gm-customization', (req, res) => {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const customization = db.prepare(`
      SELECT bg_color, primary_color, secondary_color, text_color, title_color, bg_image_data
      FROM gm_customizations
      WHERE room_id = ?
    `).get(id);

    if (customization) {
      res.json({ success: true, data: customization });
    } else {
      // Return default values if no customization exists
      res.json({
        success: true,
        data: {
          bg_color: '#1a1a1a',
          primary_color: '#007bff',
          secondary_color: '#6c757d',
          text_color: '#ffffff',
          title_color: '#ffffff',
          bg_image_data: null
        }
      });
    }
  } catch (error) {
    console.error('Error fetching GM customization:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/rooms/:id/gm-customization', (req, res) => {
  try {
    const { id } = req.params;
    const { bg_color, primary_color, secondary_color, text_color, title_color, bg_image_data } = req.body;
    const db = getDatabase();

    // Check if customization already exists
    const existing = db.prepare('SELECT id FROM gm_customizations WHERE room_id = ?').get(id);

    if (existing) {
      // Update existing customization
      db.prepare(`
        UPDATE gm_customizations
        SET bg_color = ?, primary_color = ?, secondary_color = ?, text_color = ?, title_color = ?, bg_image_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE room_id = ?
      `).run(bg_color, primary_color, secondary_color, text_color, title_color, bg_image_data, id);
    } else {
      // Create new customization
      const customizationId = nanoid();
      db.prepare(`
        INSERT INTO gm_customizations (id, room_id, bg_color, primary_color, secondary_color, text_color, title_color, bg_image_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(customizationId, id, bg_color, primary_color, secondary_color, text_color, title_color, bg_image_data);
    }

    res.json({ success: true, message: 'GM customization saved successfully' });
  } catch (error) {
    console.error('Error saving GM customization:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, getRoomByShortcode, checkAndExecuteTriggers };