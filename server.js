const { logger } = require('./utils/logger');
const { createServer } = require('./src/app');
const { closeDatabase } = require('./db/database');

const PORT = process.env.PORT || 3000;
const serverLogger = logger.child({ module: 'server-main' });

let instance;
try {
  instance = createServer();
} catch (err) {
  serverLogger.error('Failed to start Quandary Control', { error: err.message, stack: err.stack });
  process.exit(1);
}

const { app, server, io, timerService, shutdown } = instance;

server.listen(PORT, () => {
  serverLogger.info(`Server running on port ${PORT}`, {
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development',
    adminProtected: !!process.env.ADMIN_PASSWORD
  });
});

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  serverLogger.info(`${signal} received. Starting graceful shutdown...`);

  shutdown();
  io.close();
  server.close(() => {
    try { closeDatabase(); } catch (_) { /* ignore */ }
    serverLogger.info('Graceful shutdown completed');
    process.exit(0);
  });

  setTimeout(() => {
    serverLogger.error('Force closing server after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  serverLogger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  serverLogger.error('Unhandled Rejection', { reason: reason?.message || reason });
});

module.exports = { app, server, io, timerService };
