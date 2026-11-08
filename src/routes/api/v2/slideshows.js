const express = require('express');
const { nanoid } = require('nanoid');
const { getDatabase } = require('../../../../db/database');
const { asyncRoute, httpError, ok, safeJson, requireRoom } = require('./helpers');

const router = express.Router();

const SLIDE_TYPES = new Set(['image', 'video', 'text']);
const DEFAULT_SETTINGS = {
  advance: 'manual',        // manual | auto
  autoSeconds: 8,
  transition: 'fade',       // fade | slide | zoom | none
  loop: false,
  showProgress: true,
  showControls: true,
  endAction: 'player',      // player | chooser | stay | restart
  background: '#000000',
  textColor: '#ffffff',
  accent: '#f5b942',
  font: 'inter',
  cover: ''
};

function cleanSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) };
  s.advance = s.advance === 'auto' ? 'auto' : 'manual';
  s.autoSeconds = Math.max(1, Math.min(600, Number(s.autoSeconds) || 8));
  s.transition = ['fade', 'slide', 'zoom', 'none'].includes(s.transition) ? s.transition : 'fade';
  s.endAction = ['player', 'chooser', 'stay', 'restart'].includes(s.endAction) ? s.endAction : 'player';
  s.loop = !!s.loop;
  s.showProgress = s.showProgress !== false;
  s.showControls = s.showControls !== false;
  for (const k of ['background', 'textColor', 'accent', 'font', 'cover']) s[k] = String(s[k] ?? '').slice(0, 500);
  return s;
}

function cleanSlide(slide, idx) {
  const type = SLIDE_TYPES.has(slide && slide.type) ? slide.type : 'text';
  const settings = slide && slide.settings && typeof slide.settings === 'object' ? slide.settings : {};
  return {
    id: slide && typeof slide.id === 'string' && /^[\w-]{4,40}$/.test(slide.id) ? slide.id : nanoid(12),
    type,
    media_url: String((slide && slide.media_url) || '').slice(0, 1000),
    title: String((slide && slide.title) || '').slice(0, 300),
    body: String((slide && slide.body) || '').slice(0, 10000),
    settings: JSON.stringify(settings).length > 20000 ? {} : settings,
    order_index: idx
  };
}

function slideDTO(row) {
  return { ...row, settings: safeJson(row.settings, {}) };
}

function showDTO(row, { withSlides = false } = {}) {
  const db = getDatabase();
  const dto = {
    id: row.id,
    room_id: row.room_id,
    name: row.name,
    description: row.description || '',
    settings: cleanSettings(safeJson(row.settings, {})),
    order_index: row.order_index,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  const slides = db.prepare('SELECT * FROM slides WHERE slideshow_id = ? ORDER BY order_index ASC').all(row.id).map(slideDTO);
  dto.slideCount = slides.length;
  const firstVisual = slides.find(s => s.type === 'image' && s.media_url) || slides.find(s => s.media_url);
  dto.thumbnail = dto.settings.cover || (firstVisual ? firstVisual.media_url : '');
  dto.thumbnailType = dto.settings.cover ? 'image' : (firstVisual ? firstVisual.type : null);
  dto.firstSlide = slides[0] ? { type: slides[0].type, title: slides[0].title, body: slides[0].body, media_url: slides[0].media_url, settings: slides[0].settings } : null;
  dto.estimatedSeconds = slides.reduce((sum, s) => sum + (Number(s.settings.duration) || (dto.settings.advance === 'auto' ? dto.settings.autoSeconds : 0)), 0);
  if (withSlides) dto.slides = slides;
  return dto;
}

function requireShow(id) {
  const row = getDatabase().prepare('SELECT * FROM slideshows WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'Slideshow not found');
  return row;
}

function replaceSlides(db, showId, slides) {
  db.prepare('DELETE FROM slides WHERE slideshow_id = ?').run(showId);
  const insert = db.prepare('INSERT INTO slides (id, slideshow_id, type, media_url, title, body, settings, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const seen = new Set();
  slides.slice(0, 500).forEach((raw, idx) => {
    const s = cleanSlide(raw, idx);
    if (seen.has(s.id)) s.id = nanoid(12);
    seen.add(s.id);
    insert.run(s.id, showId, s.type, s.media_url, s.title, s.body, JSON.stringify(s.settings), idx);
  });
}

router.get('/rooms/:id/slideshows', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  const rows = getDatabase().prepare('SELECT * FROM slideshows WHERE room_id = ? ORDER BY order_index ASC, created_at ASC').all(room.id);
  ok(res, rows.map(r => showDTO(r)));
}));

router.post('/rooms/:id/slideshows', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const room = requireRoom(req.params.id);
  const body = req.body || {};
  const name = String(body.name || '').trim() || 'New slideshow';
  const id = nanoid(12);
  const max = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM slideshows WHERE room_id = ?').get(room.id).m;

  db.transaction(() => {
    db.prepare('INSERT INTO slideshows (id, room_id, name, description, settings, order_index) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, room.id, name.slice(0, 120), String(body.description || '').slice(0, 500), JSON.stringify(cleanSettings(body.settings)), max + 1);
    const starter = Array.isArray(body.slides) ? body.slides : [
      { type: 'text', title: name, body: 'Welcome! Here is how the game works.', settings: { layout: 'center' } }
    ];
    replaceSlides(db, id, starter);
  })();

  ok(res, showDTO(requireShow(id), { withSlides: true }), 201);
}));

router.post('/rooms/:id/slideshows/reorder', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const room = requireRoom(req.params.id);
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const stmt = db.prepare('UPDATE slideshows SET order_index = ? WHERE id = ? AND room_id = ?');
  db.transaction(() => ids.forEach((id, idx) => stmt.run(idx, id, room.id)))();
  ok(res, db.prepare('SELECT * FROM slideshows WHERE room_id = ? ORDER BY order_index ASC').all(room.id).map(r => showDTO(r)));
}));

router.get('/slideshows/:id', asyncRoute(async (req, res) => {
  const show = requireShow(req.params.id);
  const room = getDatabase().prepare('SELECT id, name, shortcode FROM rooms WHERE id = ?').get(show.room_id);
  ok(res, { ...showDTO(show, { withSlides: true }), room });
}));

router.put('/slideshows/:id', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const show = requireShow(req.params.id);
  const body = req.body || {};
  db.transaction(() => {
    db.prepare('UPDATE slideshows SET name = ?, description = ?, settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      body.name !== undefined ? (String(body.name).trim() || 'Untitled').slice(0, 120) : show.name,
      body.description !== undefined ? String(body.description).slice(0, 500) : show.description,
      JSON.stringify(cleanSettings(body.settings !== undefined ? body.settings : safeJson(show.settings, {}))),
      show.id
    );
    if (Array.isArray(body.slides)) replaceSlides(db, show.id, body.slides);
  })();
  ok(res, showDTO(requireShow(show.id), { withSlides: true }));
}));

router.post('/slideshows/:id/duplicate', asyncRoute(async (req, res) => {
  const db = getDatabase();
  const show = requireShow(req.params.id);
  const id = nanoid(12);
  const slides = db.prepare('SELECT * FROM slides WHERE slideshow_id = ? ORDER BY order_index').all(show.id)
    .map(s => ({ ...slideDTO(s), id: undefined }));
  const max = db.prepare('SELECT COALESCE(MAX(order_index), -1) AS m FROM slideshows WHERE room_id = ?').get(show.room_id).m;
  db.transaction(() => {
    db.prepare('INSERT INTO slideshows (id, room_id, name, description, settings, order_index) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, show.room_id, `${show.name} (copy)`.slice(0, 120), show.description, show.settings, max + 1);
    replaceSlides(db, id, slides);
  })();
  ok(res, showDTO(requireShow(id), { withSlides: true }), 201);
}));

router.delete('/slideshows/:id', asyncRoute(async (req, res) => {
  const show = requireShow(req.params.id);
  getDatabase().prepare('DELETE FROM slideshows WHERE id = ?').run(show.id);
  ok(res, { id: show.id });
}));

module.exports = router;
module.exports.cleanSettings = cleanSettings;
