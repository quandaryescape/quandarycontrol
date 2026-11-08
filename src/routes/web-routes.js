const express = require('express');
const path = require('path');
const { logger } = require('../../utils/logger');
const { getDatabase } = require('../../db/database');
const ShortcodeParser = require('../../utils/shortcode-parser');
const themeService = require('../services/theme-service');
const previewStore = require('../services/preview-store');

const router = express.Router();
const webLogger = logger.child({ module: 'web-routes' });
const PUBLIC = path.join(__dirname, '../../public');
const parser = new ShortcodeParser();

function page(file) {
  return (req, res) => res.sendFile(path.join(PUBLIC, file));
}

function findRoom(idOrCode) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(idOrCode)
    || db.prepare('SELECT * FROM rooms WHERE shortcode = ?').get(String(idOrCode).toUpperCase());
}

function roomTheme(room) {
  let config = {};
  try { config = JSON.parse(room.config || '{}'); } catch (_) { config = {}; }
  const theme = themeService.isValidSlug(config.theme) && themeService.exists(config.theme) ? config.theme : 'boilerplate';
  return { config, theme };
}

// Operator tools
router.get('/', page('admin.html'));
router.get('/admin', page('admin.html'));
router.get('/settings', (req, res) => res.redirect('/#settings'));
router.get('/theme-builder', page('theme-builder.html'));
router.get('/theme-builder/:slug', page('theme-builder.html'));
router.get('/tv', page('androidtv.html'));

router.get('/room/:roomId/gm', page('gm.html'));
router.get('/room/:roomId/automations', page('automations.html'));
router.get('/room/:roomId/slideshows', page('slideshow-editor.html'));
// Old rules editor URL now opens the slideshow studio
router.get('/room/:roomId/rules-editor', (req, res) => res.redirect(`/room/${encodeURIComponent(req.params.roomId)}/slideshows`));

// Player-facing
router.get('/room/:roomId/rules-slideshow', page('rules-slideshow.html'));
router.get('/room/:roomId/slideshow/:slideshowId', page('rules-slideshow.html'));

router.get('/room/:roomId/player', (req, res) => {
  try {
    const room = getDatabase().prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) {
      return res.status(404).sendFile(path.join(PUBLIC, 'player-not-found.html'));
    }
    const { config, theme } = roomTheme(room);
    const roomData = { id: room.id, name: room.name, shortcode: room.shortcode, config };

    // Theme builder live preview of an unsaved draft
    const token = typeof req.query.themePreview === 'string' ? req.query.themePreview : null;
    if (token) {
      const draft = previewStore.get(token);
      if (!draft) return res.status(410).send('Preview expired – make an edit in the Theme Builder to refresh it.');
      const injectBody = [
        req.query.demo === '1' ? '<script src="/js/theme-preview-demo.js"></script>' : '',
        req.query.editor === '1' ? '<script src="/js/theme-preview-bridge.js"></script>' : ''
      ].join('\n');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(parser.renderDraft(draft, roomData, { injectBody, injectHead: '<script>window.QC_PREVIEW = true;</script>' }));
    }

    res.setHeader('Cache-Control', 'no-cache');
    res.send(parser.loadTheme(theme, roomData));
  } catch (error) {
    webLogger.error('Error in player route', { roomId: req.params.roomId, error: error.message });
    res.status(500).send('Server error');
  }
});

// Barebones player route (template-driven)
router.get('/room/:roomId/player-bare', page('player-bare.html'));

// Shortcode-based player access route
router.get('/p/:shortcode', (req, res) => {
  try {
    const room = findRoom(req.params.shortcode);
    if (!room) {
      return res.status(404).sendFile(path.join(PUBLIC, 'player-not-found.html'));
    }
    res.redirect(`/room/${room.id}/player`);
  } catch (error) {
    webLogger.error('Error handling shortcode route', { shortcode: req.params.shortcode, error: error.message });
    res.status(500).send('Server error');
  }
});

// Short link straight to a room's slideshow(s)
router.get('/s/:shortcode', (req, res) => {
  const room = findRoom(req.params.shortcode);
  if (!room) return res.status(404).sendFile(path.join(PUBLIC, 'player-not-found.html'));
  res.redirect(`/room/${room.id}/rules-slideshow`);
});

module.exports = router;
