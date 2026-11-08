const { getDatabase } = require('../../../../db/database');
const { getServices } = require('../../../services/registry');

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => sendError(res, err));
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

function sendError(res, err) {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) console.error('[api/v2]', err);
  res.status(status).json({ success: false, error: err.message || 'Server error' });
}

function ok(res, data, status = 200) {
  res.status(status).json({ success: true, data });
}

function safeJson(str, fallback) {
  if (str === null || str === undefined || str === '') return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function requireRoom(roomId) {
  const room = getDatabase().prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) throw httpError(404, 'Room not found');
  return room;
}

function services() {
  const s = getServices();
  if (!s) throw httpError(503, 'Server is still starting');
  return s;
}

module.exports = { asyncRoute, httpError, sendError, ok, safeJson, requireRoom, services };
