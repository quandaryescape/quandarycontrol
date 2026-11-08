const express = require('express');
const { nanoid } = require('nanoid');
const { getDatabase } = require('../../../../db/database');
const { createUpload, mediaTypeFor } = require('../../upload');
const { asyncRoute, httpError, ok, sendError } = require('./helpers');

const router = express.Router();
const upload = createUpload();

/**
 * Upload one or more files. Pass roomId to also register them in the room's
 * media library (so they appear in the GM media panel).
 *   form fields: files[] (or file), roomId?, category?
 */
router.post('/uploads', (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') err.message = `File too large (max ${process.env.MAX_UPLOAD_MB || 750}MB)`;
      return sendError(res, Object.assign(err, { statusCode: err.statusCode || 400 }));
    }
    next();
  });
}, asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) throw httpError(400, 'No files received');

  const db = getDatabase();
  const roomId = req.body && req.body.roomId;
  const category = (req.body && req.body.category) || 'media';
  if (roomId && !db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) throw httpError(404, 'Room not found');

  const results = files.map(f => {
    const item = {
      url: `/uploads/${f.filename}`,
      type: mediaTypeFor(f.mimetype),
      name: f.originalname,
      size: f.size,
      mimetype: f.mimetype
    };
    if (roomId) {
      const id = nanoid();
      const max = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM room_media WHERE room_id = ?').get(roomId).m;
      db.prepare(`INSERT INTO room_media (id, room_id, type, title, url, thumbnail_url, metadata, order_index) VALUES (?, ?, ?, ?, ?, '', ?, ?)`)
        .run(id, roomId, item.type, f.originalname, item.url, JSON.stringify({ originalname: f.originalname, mimetype: f.mimetype, size: f.size, category, uploaded_at: new Date().toISOString() }), max + 1);
      item.mediaId = id;
    }
    return item;
  });

  ok(res, results, 201);
}));

/** Room media library (all categories) */
router.get('/rooms/:id/media', asyncRoute(async (req, res) => {
  const rows = getDatabase().prepare('SELECT * FROM room_media WHERE room_id = ? ORDER BY order_index ASC, created_at ASC').all(req.params.id);
  ok(res, rows.map(r => {
    let metadata = {};
    try { metadata = JSON.parse(r.metadata || '{}'); } catch (_) { /* ignore */ }
    return { ...r, metadata };
  }));
}));

module.exports = router;
