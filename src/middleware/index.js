const express = require('express');
const { requestLogging, errorLogging } = require('./logging');
const { errorHandler, notFoundHandler } = require('./error-handling');
const { adminAuth } = require('./auth');
const { logger } = require('../../utils/logger');

const middlewareLogger = logger.child({ module: 'middleware-main' });

/**
 * Initialize all middleware
 */
function initializeMiddleware(app) {
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Theme files and slideshow payloads are small; uploads go through multer, not JSON.
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ limit: '5mb', extended: true }));

  app.use(requestLogging);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // SAMEORIGIN (not DENY) so the theme builder and slideshow studio can preview in iframes
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Optional password protection for admin/GM tools (set ADMIN_PASSWORD to enable)
  app.use(adminAuth);

  middlewareLogger.info('Core middleware initialized', { adminAuth: !!process.env.ADMIN_PASSWORD });
}

/**
 * Initialize error handling middleware (should be called after routes)
 */
function initializeErrorHandling(app) {
  app.use(notFoundHandler);
  app.use(errorLogging);
  app.use(errorHandler);
}

module.exports = {
  initializeMiddleware,
  initializeErrorHandling
};
