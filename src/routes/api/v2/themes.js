const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { getDatabase } = require('../../../../db/database');
const themeService = require('../../../services/theme-service');
const previewStore = require('../../../services/preview-store');
const { isAllowed } = require('../../upload');
const { asyncRoute, httpError, ok, safeJson, sendError } = require('./helpers');

const router = express.Router();

function roomsUsing(slug) {
  return getDatabase().prepare('SELECT id, name, config FROM rooms').all()
    .filter(r => (safeJson(r.config, {}).theme || 'boilerplate') === slug)
    .map(r => ({ id: r.id, name: r.name }));
}

router.get('/themes', asyncRoute(async (req, res) => {
  const rooms = getDatabase().prepare('SELECT id, name, config FROM rooms').all();
  const usage = {};
  for (const r of rooms) {
    const t = safeJson(r.config, {}).theme || 'boilerplate';
    (usage[t] = usage[t] || []).push({ id: r.id, name: r.name });
  }
  ok(res, themeService.listThemes().map(t => ({ ...t, rooms: usage[t.slug] || [] })));
}));

router.post('/themes', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const theme = themeService.createTheme({ name: body.name, description: body.description, from: body.from || 'starter' });
  ok(res, theme, 201);
}));

/** Store an unsaved draft for the live preview iframe. */
router.post('/themes/preview', asyncRoute(async (req, res) => {
  const { slug, html, css, js, token } = req.body || {};
  if (typeof html !== 'string') throw httpError(400, 'html is required');
  const key = previewStore.put({ slug, html, css: css || '', js: js || '' }, token);
  ok(res, { token: key });
}));

router.get('/themes/:slug', asyncRoute(async (req, res) => {
  if (!themeService.isValidSlug(req.params.slug)) throw httpError(400, 'Invalid theme name');
  const theme = themeService.getTheme(req.params.slug);
  if (!theme) throw httpError(404, 'Theme not found');
  ok(res, { ...theme, rooms: roomsUsing(req.params.slug) });
}));

router.put('/themes/:slug', asyncRoute(async (req, res) => {
  const { html, css, js, config } = req.body || {};
  const theme = themeService.saveTheme(req.params.slug, { html, css, js, config });
  // Refresh any player screens using this theme
  const io = req.app.get('io');
  if (io) roomsUsing(req.params.slug).forEach(r => io.to(r.id).emit('reload_player', { reason: 'theme_saved' }));
  ok(res, theme);
}));

router.post('/themes/:slug/duplicate', asyncRoute(async (req, res) => {
  const source = themeService.getTheme(req.params.slug);
  if (!source) throw httpError(404, 'Theme not found');
  const name = (req.body && req.body.name) || `${source.config.name || req.params.slug} copy`;
  ok(res, themeService.createTheme({ name, description: source.config.description, from: req.params.slug }), 201);
}));

router.delete('/themes/:slug', asyncRoute(async (req, res) => {
  const using = roomsUsing(req.params.slug);
  if (using.length && !(req.query.force === '1')) {
    throw httpError(409, `Theme is used by ${using.map(r => r.name).join(', ')}. Switch those rooms to another theme first.`);
  }
  if (!themeService.deleteTheme(req.params.slug)) throw httpError(404, 'Theme not found');
  ok(res, { slug: req.params.slug });
}));

/* ----------------------------------------------------------------- assets */

function assetUpload(req, res, next) {
  let dir;
  try {
    if (!themeService.exists(req.params.slug)) throw httpError(404, 'Theme not found');
    dir = themeService.assetsDir(req.params.slug);
  } catch (err) {
    return sendError(res, err);
  }
  const upload = multer({
    storage: multer.diskStorage({
      destination: (r, f, cb) => cb(null, dir),
      filename: (r, f, cb) => {
        const ext = path.extname(f.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
        const base = path.basename(f.originalname || 'asset', path.extname(f.originalname || ''))
          .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset';
        const name = fs.existsSync(path.join(dir, base + ext)) ? `${base}-${nanoid(4).toLowerCase()}${ext}` : base + ext;
        cb(null, name);
      }
    }),
    limits: { fileSize: 50 * 1024 * 1024, files: 20 },
    fileFilter: (r, f, cb) => (isAllowed(f) ? cb(null, true) : cb(Object.assign(new Error(`File type not allowed: ${f.originalname}`), { statusCode: 400 })))
  });
  upload.any()(req, res, (err) => (err ? sendError(res, Object.assign(err, { statusCode: err.statusCode || 400 })) : next()));
}

router.post('/themes/:slug/assets', assetUpload, asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw httpError(400, 'No files received');
  ok(res, files.map(f => ({
    name: f.filename,
    url: `/themes/${req.params.slug}/assets/${encodeURIComponent(f.filename)}`,
    relative: `assets/${f.filename}`,
    size: f.size
  })), 201);
}));

router.delete('/themes/:slug/assets/:name', asyncRoute(async (req, res) => {
  if (themeService.PROTECTED_THEMES.has(req.params.slug)) throw httpError(403, 'This theme is read-only');
  const name = path.basename(req.params.name);
  const file = path.join(themeService.assetsDir(req.params.slug), name);
  if (!fs.existsSync(file)) throw httpError(404, 'Asset not found');
  fs.unlinkSync(file);
  ok(res, { name });
}));

module.exports = router;
