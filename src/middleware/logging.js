const { logger } = require('../../utils/logger');

/**
 * Request logging middleware
 * Logs all HTTP requests with timing and response status
 */
function requestLogging(req, res, next) {
  const start = Date.now();

  // Skip logging for static assets to reduce noise
  if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
    return next();
  }

  logger.debug(`${req.method} ${req.originalUrl} - Started`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')?.substring(0, 100), // Truncate long user agents
    referer: req.get('Referer')
  });

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`, {
      statusCode: res.statusCode,
      duration,
      ip: req.ip,
      responseSize: res.get('content-length') || 0
    });
  });

  next();
}

/**
 * Error logging middleware
 * Logs all Express errors with full context
 */
function errorLogging(error, req, res, next) {
  logger.error('Express Error', {
    message: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body,
    params: req.params,
    query: req.query
  });

  next(error);
}

module.exports = {
  requestLogging,
  errorLogging
};