const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { getDatabase } = require('../db/database');
const { initializeMiddleware, initializeErrorHandling } = require('./middleware');
const { initializeRoutes } = require('./routes');
const { initializeWebSocket } = require('./websocket');
const TimerService = require('./services/timer-service');
const { VariableService } = require('./services/variable-service');
const { AutomationEngine } = require('./services/automation-engine');
const { setServices } = require('./services/registry');

/**
 * Build the Express app, HTTP server, Socket.IO server and services without
 * listening, so tests can create isolated instances.
 */
function createServer() {
  getDatabase();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    // Escape room screens can sit idle for a long time; keep them connected.
    pingInterval: 20000,
    pingTimeout: 25000
  });

  const timerService = new TimerService();
  timerService.io = io;
  const variableService = new VariableService({ io, timerService });
  const automationEngine = new AutomationEngine({ io, timerService, variableService });
  variableService.setEngine(automationEngine);

  timerService.setHooks({
    onTick: (roomId, type, data) => {
      automationEngine.onTimerTick(roomId, type, data).catch(() => {});
    },
    onStateChange: (roomId, type, phase, state) => {
      automationEngine.onTimerState(roomId, type, phase, state).catch(() => {});
    }
  });

  const services = { io, timerService, variableService, automationEngine };
  setServices(services);

  app.set('io', io);
  app.set('services', services);

  initializeMiddleware(app);
  initializeRoutes(app);
  initializeErrorHandling(app);
  initializeWebSocket(io, timerService, services);

  function shutdown() {
    timerService.clearAllTimers();
    automationEngine.shutdown();
  }

  return { app, server, io, timerService, variableService, automationEngine, services, shutdown };
}

module.exports = { createServer };
