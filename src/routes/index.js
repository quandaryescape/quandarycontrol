const express = require('express');
const path = require('path');
const webRoutes = require('./web-routes');
const layoutRoutes = require('./layout-routes');
const { logger } = require('../../utils/logger');
const themeService = require('../services/theme-service');

const routeLogger = logger.child({ module: 'routes-main' });
const ROOT = path.join(__dirname, '..', '..');

/**
 * Initialize all routes
 */
function initializeRoutes(app) {
  // Web routes (HTML pages)
  app.use('/', webRoutes);

  // Layout management routes
  app.use('/', layoutRoutes);

  // API v2: rooms, slideshows, automations, themes, AI, settings
  app.use('/api/v2', require('./api/v2'));

  // Short, hardware-friendly inbound webhook URLs
  app.use('/api/hooks', require('./api/v2/hooks'));

  // API v1 routes (modular legacy)
  app.use('/api/v1', require('./api/v1'));

  // Legacy API routes (used by existing themes and hardware integrations)
  const { router: apiRouter } = require('../../routes/api');
  app.use('/api', apiRouter);

  // Template routes
  app.use('/api/templates', require('../../api/template-routes'));

  // Vendored editor library (works offline)
  app.use('/vendor/codemirror', express.static(path.join(ROOT, 'node_modules', 'codemirror'), { maxAge: '7d' }));
  app.use('/vendor/lucide', express.static(path.join(ROOT, 'node_modules', 'lucide-static', 'font'), { maxAge: '30d' }));
  // Bundled fonts (UI + selectable timer fonts) so screens work without internet
  app.use('/vendor/fontsource', express.static(path.join(ROOT, 'node_modules', '@fontsource'), { maxAge: '30d' }));
  app.use('/vendor/fontsource-variable', express.static(path.join(ROOT, 'node_modules', '@fontsource-variable'), { maxAge: '30d' }));

  // Theme assets
  app.use('/themes', express.static(themeService.THEMES_DIR, { maxAge: 0 }));

  // Uploaded media rarely changes once written (names are unique)
  app.use('/uploads', express.static(path.join(ROOT, 'public', 'uploads'), { maxAge: '7d', immutable: true }));

  // Static files should come after specific routes
  // (ETag revalidation, no max-age, so updates show immediately after a deploy)
  app.use(express.static(path.join(ROOT, 'public')));

  routeLogger.info('All routes initialized successfully');
}

module.exports = { initializeRoutes };
